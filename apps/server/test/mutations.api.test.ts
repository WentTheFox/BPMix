import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { encodeTrackKey, type DeviceCodeResultDto, type DeviceWaitResultDto, type MutationDto, type MutationsResponseDto } from '@beatseam/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/http.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { LocalReplica, sorted } from './replica.js';
import { resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, setUpUser, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let prisma: DatabaseService['prisma'];
let alice: TestClient;

const key = (name: string) => encodeTrackKey(`Music:${name}.mp3`);
const op = () => randomUUID();
const send = async (client: TestClient, ...mutations: MutationDto[]) => (await client.post<MutationsResponseDto>('/api/v1/mutations', { mutations })).results;
const playlistOf = async (client: TestClient, id: string) => {
  const replica = new LocalReplica();
  await replica.checkIn(client);
  return replica.userPlaylists.get(id);
};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'beatseam-mutations-'));
  delete process.env.BEATSEAM_ORIGIN;
  process.env.BEATSEAM_SETUP_TOKEN = 'none'; // open first sign-up, as most tests set up an admin directly
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BEATSEAM_LIBRARY_ROOT: base, BEATSEAM_SCAN_ON_START: 'false', BEATSEAM_DATA_DIR: path.join(base, 'data'), BEATSEAM_AUTH_RATE_LIMIT: '1000', BEATSEAM_DEVICE_WAIT_MS: '1500' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttp(app as NestExpressApplication);
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
  prisma = app.get(DatabaseService).prisma;
}, 60_000);

beforeEach(async () => {
  await resetDatabase(prisma);
  await prisma.change.deleteMany();
  alice = (await setUpAdmin(url, clock, 'alice')).client;
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('offline mutations', () => {
  it('lets a user build and edit a playlist, and the sync feed carries every step', async () => {
    const id = randomUUID();
    const replica = new LocalReplica();
    await replica.checkIn(alice);

    const results = await send(
      alice,
      { type: 'playlist.create', opId: op(), id, name: 'Road trip', trackIds: [key('a'), key('b')] },
      { type: 'playlist.addTracks', opId: op(), id, trackIds: [key('c'), key('a')] }, // a is already there
      { type: 'playlist.removeTracks', opId: op(), id, trackIds: [key('b')] },
      { type: 'playlist.rename', opId: op(), id, name: 'Road trip 2' },
    );
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);

    await replica.checkIn(alice);
    expect(replica.userPlaylists.get(id)).toMatchObject({ id, name: 'Road trip 2', trackIds: [key('a'), key('c')] });

    await send(alice, { type: 'playlist.setTracks', opId: op(), id, trackIds: [key('c'), key('a'), key('c')] });
    expect((await playlistOf(alice, id))?.trackIds).toEqual([key('c'), key('a'), key('c')]); // reorder/replace may repeat

    await send(alice, { type: 'playlist.delete', opId: op(), id });
    await replica.checkIn(alice);
    expect(replica.userPlaylists.has(id)).toBe(false);
  });

  it('applies a retried batch exactly once, and an old retry cannot undo a newer change', async () => {
    const id = randomUUID();
    const create: MutationDto = { type: 'playlist.create', opId: op(), id, name: 'First', trackIds: [] };
    const rename: MutationDto = { type: 'playlist.rename', opId: op(), id, name: 'Second' };
    expect((await send(alice, create, rename)).map((r) => r.status)).toEqual(['applied', 'applied']);
    const revBefore = (await prisma.change.aggregate({ _max: { rev: true } }))._max.rev;

    // The connection dropped after the server applied everything; the client resends the lot.
    expect((await send(alice, create, rename)).map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect((await playlistOf(alice, id))?.name).toBe('Second');
    expect((await prisma.change.aggregate({ _max: { rev: true } }))._max.rev).toBe(revBefore); // and changed nothing, so nothing to sync
    expect(await prisma.appliedMutation.count()).toBe(2);
  });

  it('merges two devices that edited the same playlist while offline', async () => {
    const id = randomUUID();
    await send(alice, { type: 'playlist.create', opId: op(), id, name: 'Shared', trackIds: [key('a'), key('b'), key('c')] });
    // Device 1 and device 2 both start from [a, b, c] and edit offline; their queues arrive in either order.
    const device1: MutationDto[] = [
      { type: 'playlist.addTracks', opId: op(), id, trackIds: [key('d')] },
      { type: 'playlist.removeTracks', opId: op(), id, trackIds: [key('a')] },
    ];
    const device2: MutationDto[] = [
      { type: 'playlist.addTracks', opId: op(), id, trackIds: [key('e'), key('d')] },
      { type: 'playlist.removeTracks', opId: op(), id, trackIds: [key('b')] },
    ];
    await send(alice, ...device2);
    await send(alice, ...device1);
    expect((await playlistOf(alice, id))?.trackIds).toEqual([key('c'), key('e'), key('d')]);
  });

  it('serialises concurrent edits to one playlist instead of losing one', async () => {
    const id = randomUUID();
    await send(alice, { type: 'playlist.create', opId: op(), id, name: 'Busy', trackIds: [] });
    const names = Array.from({ length: 12 }, (_, i) => key(`t${i}`));
    await Promise.all(names.map((name) => send(alice, { type: 'playlist.addTracks', opId: op(), id, trackIds: [name] })));
    expect([...((await playlistOf(alice, id))?.trackIds ?? [])].sort()).toEqual([...names].sort());
  });

  it("keeps other people's data out of reach", async () => {
    const { client: bob } = await setUpUser(alice, url, clock, 'bob');
    const id = randomUUID();
    await send(alice, { type: 'playlist.create', opId: op(), id, name: 'Alice only', trackIds: [key('a')] });

    // Bob can't change it: rename is rejected, delete is a harmless no-op, add/remove/set are rejected...
    const attempts = await send(
      bob,
      { type: 'playlist.rename', opId: op(), id, name: 'Hijacked' },
      { type: 'playlist.addTracks', opId: op(), id, trackIds: [key('z')] },
      { type: 'playlist.removeTracks', opId: op(), id, trackIds: [key('a')] },
      { type: 'playlist.setTracks', opId: op(), id, trackIds: [] },
      { type: 'playlist.delete', opId: op(), id },
      { type: 'playlist.create', opId: op(), id, name: 'Mine now', trackIds: [] },
    );
    expect(attempts.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'applied', 'rejected']);
    expect(await playlistOf(alice, id)).toMatchObject({ name: 'Alice only', trackIds: [key('a')] });

    // ...and none of Alice's data shows up in Bob's feed, snapshot or deltas.
    await send(alice, { type: 'setting.set', opId: op(), key: 'theme', value: 'dark' }, { type: 'playbackState.set', opId: op(), deviceId: 'phone', state: { positionSeconds: 5 } });
    const bobReplica = new LocalReplica();
    await bobReplica.checkIn(bob);
    expect([bobReplica.userPlaylists.size, bobReplica.settings.size, bobReplica.playbackStates.size]).toEqual([0, 0, 0]);
    await send(alice, { type: 'setting.set', opId: op(), key: 'volume', value: '0.5' });
    await bobReplica.checkIn(bob);
    expect([bobReplica.userPlaylists.size, bobReplica.settings.size, bobReplica.playbackStates.size]).toEqual([0, 0, 0]);
    const aliceReplica = new LocalReplica();
    await aliceReplica.checkIn(alice);
    expect(aliceReplica.settings.size).toBe(2);
  });

  it('rejects what can never succeed, keeps going, and does not remember rejected ids', async () => {
    const id = randomUUID();
    const bad = op();
    const results = await send(
      alice,
      { type: 'playlist.rename', opId: bad, id: 'no-such-playlist', name: 'x' },
      { type: 'playlist.create', opId: op(), id, name: 'Fine', trackIds: [] },
      { type: 'playlist.addTracks', opId: op(), id, trackIds: ['***not base64***'] },
      { type: 'playbackState.set', opId: op(), deviceId: 'huge', state: { blob: 'x'.repeat(300_000) } },
      { type: 'setting.set', opId: op(), key: 'big', value: 'y'.repeat(20_000) },
    );
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['rejected', 'No such playlist'],
      ['applied', undefined],
      ['rejected', 'Malformed track id'],
      ['rejected', 'Playback state too large'],
      ['rejected', 'Setting value too large'],
    ]);
    // Only the one that worked was recorded; the playlist survives the rejected op next to it.
    expect(await prisma.appliedMutation.count()).toBe(1);
    expect((await send(alice, { type: 'playlist.rename', opId: bad, id: 'no-such-playlist', name: 'x' }))[0]!.status).toBe('rejected');
    expect((await playlistOf(alice, id))?.name).toBe('Fine');
  });

  it('stores settings and per-device playback state, and removes them cleanly', async () => {
    await send(
      alice,
      { type: 'setting.set', opId: op(), key: 'crossfadeSeconds', value: '8' },
      { type: 'setting.set', opId: op(), key: 'crossfadeSeconds', value: '10' },
      { type: 'playbackState.set', opId: op(), deviceId: 'phone', state: { currentTrackFileId: 'Music:a.mp3', positionSeconds: 12.5 } },
      { type: 'playbackState.set', opId: op(), deviceId: 'laptop', state: { currentTrackFileId: 'Music:b.mp3', positionSeconds: 99 } },
    );
    const replica = new LocalReplica();
    await replica.checkIn(alice);
    expect(replica.settings.get('crossfadeSeconds')).toMatchObject({ key: 'crossfadeSeconds', value: '10' });
    expect([...replica.playbackStates.keys()].sort()).toEqual(['laptop', 'phone']);
    expect(replica.playbackStates.get('phone')?.state).toEqual({ currentTrackFileId: 'Music:a.mp3', positionSeconds: 12.5 });

    await send(alice, { type: 'setting.delete', opId: op(), key: 'crossfadeSeconds' }, { type: 'playbackState.set', opId: op(), deviceId: 'phone', state: { positionSeconds: 30 } });
    await replica.checkIn(alice);
    expect(replica.settings.size).toBe(0);
    expect(replica.playbackStates.get('phone')?.state).toEqual({ positionSeconds: 30 });
  });

  it('enforces per-user limits', async () => {
    const me = (await alice.json<{ id: string }>('/api/v1/auth/me')).id;
    await prisma.userSetting.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ userId: me, key: `k${i}`, value: 'v' })) });
    const [overflow, overwrite] = await send(alice, { type: 'setting.set', opId: op(), key: 'one-too-many', value: 'v' }, { type: 'setting.set', opId: op(), key: 'k1', value: 'changed' });
    expect(overflow).toMatchObject({ status: 'rejected', error: 'Too many settings' });
    expect(overwrite!.status).toBe('applied'); // updating an existing one is still fine
  });

  it('validates the request itself', async () => {
    const post = (body: unknown) => alice.fetch('/api/v1/mutations', { method: 'POST', json: body });
    expect((await post({ mutations: [] })).status).toBe(400);
    expect((await post({ mutations: [{ type: 'playlist.explode', opId: op() }] })).status).toBe(400);
    expect((await post({ mutations: [{ type: 'playlist.rename', opId: 'x', id: 'abcdefgh', name: 'n' }] })).status).toBe(400); // op id too short
    expect((await post({ mutations: Array.from({ length: 101 }, () => ({ type: 'setting.delete', opId: op(), key: 'k' })) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await new TestClient(url).fetch('/api/v1/mutations', { method: 'POST', json: { mutations: [] } })).status).toBe(401);
  });

  it("lets a native app's device token queue changes and sync, using its own user's data", async () => {
    const device = new TestClient(url);
    const grant = await device.post<DeviceCodeResultDto>('/api/v1/auth/device/code', { deviceName: 'Phone' });
    await alice.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode, approve: true } });
    const result = await device.json<DeviceWaitResultDto>('/api/v1/auth/device/wait', { method: 'POST', json: { deviceCode: grant.deviceCode } });
    if (result.status !== 'approved') throw new Error('not approved');
    device.bearer = result.token;

    const id = randomUUID();
    expect((await send(device, { type: 'playlist.create', opId: op(), id, name: 'From the phone', trackIds: [] }))[0]!.status).toBe('applied');
    const replica = new LocalReplica();
    await replica.checkIn(device);
    expect(replica.userPlaylists.get(id)?.name).toBe('From the phone');
    expect((await playlistOf(alice, id))?.name).toBe('From the phone');
  });

  it('keeps two devices converged through random offline edits delivered in different orders', async () => {
    let seed = 987;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ids = [randomUUID(), randomUUID()];
    await send(alice, ...ids.map((id): MutationDto => ({ type: 'playlist.create', opId: op(), id, name: 'p', trackIds: [] })));
    const pool = Array.from({ length: 6 }, (_, i) => key(`r${i}`));
    const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
    const phone = new LocalReplica();
    const laptop = new LocalReplica();
    for (let round = 0; round < 12; round++) {
      const queue: MutationDto[] = Array.from({ length: 1 + Math.floor(random() * 5) }, (): MutationDto => {
        const id = pick(ids);
        const roll = random();
        if (roll < 0.4) return { type: 'playlist.addTracks', opId: op(), id, trackIds: [pick(pool), pick(pool)] };
        if (roll < 0.7) return { type: 'playlist.removeTracks', opId: op(), id, trackIds: [pick(pool)] };
        if (roll < 0.85) return { type: 'playlist.rename', opId: op(), id, name: `n${round}` };
        return { type: 'setting.set', opId: op(), key: pick(['a', 'b', 'c']), value: String(round) };
      });
      await send(alice, ...queue);
      if (random() < 0.5) await send(alice, ...queue); // the retry
      await (random() < 0.5 ? phone : laptop).checkIn(alice, 1 + Math.floor(random() * 3));
    }
    await phone.checkIn(alice);
    await laptop.checkIn(alice);
    const server = new LocalReplica();
    await server.snapshot(alice);
    expect(sorted(phone.userPlaylists)).toEqual(sorted(server.userPlaylists));
    expect(sorted(laptop.userPlaylists)).toEqual(sorted(server.userPlaylists));
    expect(sorted(laptop.settings)).toEqual(sorted(server.settings));
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { LastFmConnectResultDto, LastFmStatusDto } from '@beatseam/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { LASTFM_FETCH } from '../src/lastfm/lastfm.service.js';
import { resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, setUpUser, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let base: string;
let url: string;
let admin: TestClient;

/** A stand-in for ws.audioscrobbler.com: records what it was asked and answers as the test says. */
const lastFm = {
  calls: [] as Record<string, string>[],
  approved: false,
  /** Replaces the answer for one method: an error code, or 'down' for no route to Last.fm at all. */
  fail: new Map<string, number | 'down'>(),
};
const fakeLastFm = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = String(input);
  const params = Object.fromEntries(new URLSearchParams(init?.body ? String(init.body) : raw.split('?')[1] ?? ''));
  lastFm.calls.push(params);
  const method = params.method!;
  const failure = lastFm.fail.get(method);
  if (failure === 'down') throw new TypeError('network down');
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (typeof failure === 'number') return ok({ error: failure, message: `Last.fm error ${failure}` });
  if (method === 'auth.getToken') return ok({ token: 'tok-1' });
  if (method === 'auth.getSession') return lastFm.approved ? ok({ session: { name: 'Sam_FM', key: 'sk-secret-123' } }) : ok({ error: 14, message: 'Unauthorized Token' });
  return ok({});
}) as typeof fetch;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'beatseam-lastfm-'));
  delete process.env.BEATSEAM_ORIGIN;
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BEATSEAM_LIBRARY_ROOT: base, BEATSEAM_SCAN_ON_START: 'false', BEATSEAM_DATA_DIR: path.join(base, 'data'), BEATSEAM_AUTH_RATE_LIMIT: '1000', BEATSEAM_SETUP_TOKEN: 'none' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK).useValue(clock.now)
    .overrideProvider(LASTFM_FETCH).useValue(fakeLastFm)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
}, 60_000);

beforeEach(async () => {
  await resetDatabase(app.get(DatabaseService).prisma);
  lastFm.calls.length = 0;
  lastFm.approved = false;
  lastFm.fail.clear();
  admin = (await setUpAdmin(url, clock)).client;
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const post = (c: TestClient, p: string, json?: unknown) => c.fetch(p, { method: 'POST', json: json ?? {} });
const entry = (over: Record<string, unknown> = {}) => ({ artist: 'Ann', track: 'Song', timestamp: 1_700_000_000, album: 'Album', durationSeconds: 200, ...over });

async function connected(client = admin) {
  await post(client, '/api/v1/lastfm/connect');
  lastFm.approved = true;
  expect((await post(client, '/api/v1/lastfm/complete')).status).toBe(200);
  lastFm.calls.length = 0;
}

describe('connecting', () => {
  it('walks through token, approval and session, keeping the session sealed', async () => {
    expect(await admin.json<LastFmStatusDto>('/api/v1/lastfm')).toEqual({ connected: false, username: null });
    const { authUrl } = await admin.json<LastFmConnectResultDto>('/api/v1/lastfm/connect', { method: 'POST', json: {} });
    expect(authUrl).toContain('https://www.last.fm/api/auth/');
    expect(authUrl).toContain('token=tok-1');

    const early = await post(admin, '/api/v1/lastfm/complete');
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'not_authorized' });

    lastFm.approved = true;
    expect(await (await post(admin, '/api/v1/lastfm/complete')).json()).toEqual({ connected: true, username: 'Sam_FM' });
    expect(await admin.json<LastFmStatusDto>('/api/v1/lastfm')).toEqual({ connected: true, username: 'Sam_FM' });

    const row = await app.get(DatabaseService).prisma.lastFmConnection.findFirstOrThrow();
    expect(row.sessionKeyEnc).toBeTruthy();
    expect(row.sessionKeyEnc).not.toContain('sk-secret-123');
    expect(row.pendingToken).toBeNull();
  });

  it('refuses to complete with nothing in progress, and disconnecting forgets the link', async () => {
    expect((await post(admin, '/api/v1/lastfm/complete')).status).toBe(400);
    await connected();
    expect(await (await admin.fetch('/api/v1/lastfm', { method: 'DELETE' })).json()).toEqual({ connected: false, username: null });
    expect(await app.get(DatabaseService).prisma.lastFmConnection.count()).toBe(0);
  });

  it('is per user', async () => {
    await connected();
    const { client: bob } = await setUpUser(admin, url, clock, 'bob');
    expect(await bob.json<LastFmStatusDto>('/api/v1/lastfm')).toEqual({ connected: false, username: null });
    expect((await post(bob, '/api/v1/lastfm/scrobbles', { entries: [entry()] })).status).toBe(409);
  });
});

describe('scrobbling and now playing', () => {
  it('sends them to Last.fm with the user\'s session, signed', async () => {
    await connected();
    expect((await post(admin, '/api/v1/lastfm/now-playing', { artist: 'Ann', track: 'Song', album: null, durationSeconds: 200 })).status).toBe(204);
    expect((await post(admin, '/api/v1/lastfm/scrobbles', { entries: [entry(), entry({ track: 'Two', timestamp: 1_700_000_300 })] })).status).toBe(204);
    expect(lastFm.calls[0]).toMatchObject({ method: 'track.updateNowPlaying', sk: 'sk-secret-123', artist: 'Ann', track: 'Song' });
    expect(lastFm.calls[1]).toMatchObject({ method: 'track.scrobble', sk: 'sk-secret-123', 'artist[0]': 'Ann', 'track[1]': 'Two', 'timestamp[1]': '1700000300' });
    expect(lastFm.calls[1]!.api_sig).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is a 409 until connected, and rejects malformed or oversized batches', async () => {
    expect((await post(admin, '/api/v1/lastfm/scrobbles', { entries: [entry()] })).status).toBe(409);
    await connected();
    expect((await post(admin, '/api/v1/lastfm/scrobbles', { entries: [] })).status).toBe(400);
    expect((await post(admin, '/api/v1/lastfm/scrobbles', { entries: Array.from({ length: 51 }, () => entry()) })).status).toBe(400);
    expect((await post(admin, '/api/v1/lastfm/scrobbles', { entries: [entry({ timestamp: -5 })] })).status).toBe(400);
  });

  it('says whether to retry: 422 when Last.fm refuses, 502 when it cannot be reached', async () => {
    await connected();
    lastFm.fail.set('track.scrobble', 6);
    const refused = await post(admin, '/api/v1/lastfm/scrobbles', { entries: [entry()] });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'lastfm_rejected', lastFmCode: 6 });

    lastFm.fail.set('track.scrobble', 'down');
    const down = await post(admin, '/api/v1/lastfm/scrobbles', { entries: [entry()] });
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ code: 'lastfm_unreachable' });
  });

  it('disconnects when Last.fm says the session is dead', async () => {
    await connected();
    lastFm.fail.set('track.scrobble', 9);
    expect((await post(admin, '/api/v1/lastfm/scrobbles', { entries: [entry()] })).status).toBe(422);
    expect(await admin.json<LastFmStatusDto>('/api/v1/lastfm')).toEqual({ connected: false, username: null });
  });

  it('needs a sign-in', async () => {
    expect((await new TestClient(url).fetch('/api/v1/lastfm')).status).toBe(401);
  });
});

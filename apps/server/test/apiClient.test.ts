import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiClient, ApiError, NetworkError, ResyncRequiredError, type DeviceSignInProgress } from '@bpmix/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/http.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { ScannerService } from '../src/scanner/scanner.service.js';
import { ANALYZE_FILE } from '../src/scanner/tokens.js';
import { realAnalyze, resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, type TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let prisma: DatabaseService['prisma'];
let admin: TestClient;

/** What an app does: sign in with a device code (approved here by the signed-in admin), and keep the token. */
async function signedInApiClient(): Promise<ApiClient> {
  // The client reads the token on every request; it only exists once sign-in finishes, hence a holder.
  const auth: { token?: string } = {};
  const anonymous = new ApiClient({ baseUrl: url, getToken: () => auth.token });
  const progress: DeviceSignInProgress[] = [];
  const signingIn = anonymous.signInWithDeviceCode('Test phone', (p) => progress.push(p));
  // The user reads the code off the app and approves it in their browser.
  await expect.poll(() => progress.find((p) => p.kind === 'code'), { timeout: 5000 }).toBeTruthy();
  const shown = progress.find((p) => p.kind === 'code') as Extract<DeviceSignInProgress, { kind: 'code' }>;
  expect(shown.verificationUri).toBe(`${url}/device?code=${shown.userCode}`);
  expect((await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: shown.userCode, approve: true } })).status).toBe(204);
  const result = await signingIn;
  if (!('token' in result)) throw new Error('sign-in did not complete');
  expect(result.me).toMatchObject({ username: 'admin', via: 'device' });
  auth.token = result.token;
  return anonymous;
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-apiclient-'));
  await mkdir(path.join(base, 'Music'), { recursive: true });
  for (const [file, hz] of [['a.mp3', 220], ['b.mp3', 330]] as const) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`, '-metadata', `title=${file}`, path.join(base, 'Music', file)]);
  }
  delete process.env.BPMIX_ORIGIN;
  process.env.BPMIX_SETUP_TOKEN = 'none'; // open first sign-up, as most tests set up an admin directly
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_DATA_DIR: path.join(base, 'data'), BPMIX_AUTH_RATE_LIMIT: '1000', BPMIX_DEVICE_WAIT_MS: '1500', BPMIX_SCAN_BACKOFF_MS: '0' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).overrideProvider(ANALYZE_FILE).useValue(realAnalyze).compile();
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
  admin = (await setUpAdmin(url, clock)).client;
  await app.get(ScannerService).scanAll();
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('ApiClient against the real server', () => {
  it('signs in with a device code, then reads the library, syncs and queues changes', async () => {
    const api = await signedInApiClient();
    expect(await api.authStatus()).toEqual({ setupRequired: false, setupTokenRequired: false });
    expect(await api.me()).toMatchObject({ username: 'admin', via: 'device' });

    const tracks = await api.listTracks({ limit: 10 });
    expect(tracks.items.map((t) => t.relativePath)).toEqual(['a.mp3', 'b.mp3']);
    expect(tracks.items[0]).toMatchObject({ title: 'a.mp3', hasCover: false });

    // First sync, in small pages, then a delta.
    const first = await api.syncSnapshot(undefined, 1);
    expect(first.entities).toHaveLength(1);
    expect(first.next).not.toBeNull();
    // A page that ends exactly on the limit can't know it was the last; the client just asks again.
    let next: string | null = first.next;
    let fetched = first.entities.length;
    while (next) {
      const page = await api.syncSnapshot(next, 1);
      fetched += page.entities.length;
      next = page.next;
    }
    expect(fetched).toBe(2);
    await prisma.trackMetadata.update({ where: { fileId: 'Music:a.mp3' }, data: { title: 'renamed' } });
    const delta = await api.syncChanges(first.cursor);
    expect(delta.changes).toEqual([expect.objectContaining({ entity: 'track', track: expect.objectContaining({ title: 'renamed' }) })]);
    expect(delta.roots.map((r) => r.id)).toContain('Music');

    const results = await api.mutations([{ type: 'setting.set', opId: 'op-from-client-1', key: 'crossfadeSeconds', value: '6' }]);
    expect(results.results).toEqual([{ opId: 'op-from-client-1', status: 'applied' }]);
    const afterMutation = await api.syncChanges(delta.cursor);
    expect(afterMutation.changes).toEqual([expect.objectContaining({ entity: 'setting', setting: expect.objectContaining({ key: 'crossfadeSeconds', value: '6' }) })]);
  });

  it('downloads audio with the token, whole or a range', async () => {
    const api = await signedInApiClient();
    const [track] = (await api.listTracks()).items;
    const path = api.streamPath(track!.id);
    const whole = await api.fetchBytes(path);
    expect(whole.byteLength).toBe(track!.sizeBytes);
    const head = await api.fetchBytes(path, { range: { start: 0, end: 9 } });
    expect(head.byteLength).toBe(10);
    expect(new Uint8Array(head)).toEqual(new Uint8Array(whole).slice(0, 10));
    await expect(api.fetchBytes(api.streamPath('AAAA'))).rejects.toMatchObject({ status: 400 }); // decodes to NUL bytes
    await expect(api.fetchBytes(api.streamPathForFileId('Music:missing.mp3'))).rejects.toMatchObject({ status: 404 });
    expect(api.streamPathForFileId('Music:a.mp3')).toBe(api.streamPath(track!.id));
  });

  it('reports errors precisely: unauthorised, resync required, unreachable, bad responses', async () => {
    const nobody = new ApiClient({ baseUrl: url });
    await expect(nobody.listTracks()).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    await expect(nobody.syncChanges('0')).rejects.toBeInstanceOf(ApiError);

    const api = await signedInApiClient();
    await expect(api.syncChanges('99999999')).rejects.toBeInstanceOf(ResyncRequiredError);
    await expect(api.syncChanges('not-a-number')).rejects.toMatchObject({ status: 400 });

    await expect(new ApiClient({ baseUrl: 'http://127.0.0.1:1' }).authStatus()).rejects.toBeInstanceOf(NetworkError);
    await expect(new ApiClient({ baseUrl: url, fetch: async () => new Response(JSON.stringify({ setupRequired: 'maybe' }), { status: 200 }) }).authStatus()).rejects.toThrow();
  });

  it('can be cancelled while waiting for approval', async () => {
    const api = new ApiClient({ baseUrl: url });
    const controller = new AbortController();
    const waiting = api.signInWithDeviceCode('Impatient', () => controller.abort(), controller.signal);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
});

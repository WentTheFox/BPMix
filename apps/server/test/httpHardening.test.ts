import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_VERSION, SUPPORTED_API_VERSIONS } from '@beatseam/api';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { configureHttp } from '../src/http.js';
import { resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, type TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let admin: TestClient;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'beatseam-hardening-'));
  delete process.env.BEATSEAM_ORIGIN;
  process.env.BEATSEAM_SETUP_TOKEN = 'none'; // open first sign-up, as most tests set up an admin directly
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BEATSEAM_LIBRARY_ROOT: base, BEATSEAM_SCAN_ON_START: 'false', BEATSEAM_DATA_DIR: path.join(base, 'data'), BEATSEAM_AUTH_RATE_LIMIT: '1000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttp(app as NestExpressApplication);
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
}, 60_000);

beforeEach(async () => {
  await resetDatabase(app.get(DatabaseService).prisma);
  admin = (await setUpAdmin(url, clock)).client;
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('response headers', () => {
  it('are set on API responses, and sign-in responses are never cached', async () => {
    const api = await admin.fetch('/api/v1/auth/me');
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    expect(api.headers.get('referrer-policy')).toBe('no-referrer');
    expect(api.headers.get('x-frame-options')).toBe('DENY');
    expect(api.headers.get('x-powered-by')).toBeNull();
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('strict-transport-security')).toBeNull(); // plain http here
    const tracks = await admin.fetch('/api/v1/tracks');
    expect(tracks.headers.get('x-content-type-options')).toBe('nosniff');
    expect(tracks.headers.get('cache-control')).not.toBe('no-store');
  });
});

describe('NUL characters, which Postgres cannot store', () => {
  it('are refused with a 400 wherever they appear, never a 500', async () => {
    expect((await admin.fetch('/api/v1/tracks?q=%00')).status).toBe(400);
    expect((await admin.fetch('/api/v1/tracks?cursor=a%00b')).status).toBe(400);
    expect((await admin.fetch('/api/v1/tracks/AAAA')).status).toBe(400); // a key that decodes to NUL bytes
    expect((await admin.fetch('/api/v1/tracks/AAAA/stream')).status).toBe(400);
    expect((await admin.fetch('/api/v1/playlists/AAAA')).status).toBe(400);
    expect((await admin.fetch('/api/v1/scan/failures?trackId=AAAA')).status).toBe(400);

    const json = (body: string) => admin.fetch('/api/v1/mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const op = (extra: string) => `{"mutations":[{"type":"playlist.create","opId":"op-00000001","id":"playlist-0001",${extra}}]}`;
    expect((await json(op('"name":"bad\\u0000name"'))).status).toBe(400);
    expect((await json(op('"name":"bad\\u0000name"'))).status).toBe(400); // and nothing was half-applied
    expect((await admin.fetch('/api/v1/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"a\\u0000b","displayName":"x"}' })).status).toBe(400);
    // Ordinary traffic is unaffected.
    expect((await json(op('"name":"fine"'))).status).toBe(201);
  });
});

describe('API version negotiation', () => {
  it('advertises the versions it speaks on every API response, errors included', async () => {
    expect((await admin.fetch('/api/v1/auth/me')).headers.get('x-beatseam-api-versions')).toBe(SUPPORTED_API_VERSIONS.join(','));
    expect((await fetch(`${url}/api/v1/health`)).headers.get('x-beatseam-api-versions')).toBe(SUPPORTED_API_VERSIONS.join(','));
    expect((await fetch(`${url}/api/v1/tracks`)).headers.get('x-beatseam-api-versions')).toBe(SUPPORTED_API_VERSIONS.join(',')); // 401, still advertised
  });

  it('serves a client that speaks a supported version, and one that names none', async () => {
    expect((await fetch(`${url}/api/v1/health`, { headers: { 'x-beatseam-api': String(API_VERSION) } })).status).toBe(200);
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
  });

  it('answers 426 to a client on an unsupported version, public routes included, saying who has to update', async () => {
    const newer = await fetch(`${url}/api/v1/health`, { headers: { 'x-beatseam-api': String(Math.max(...SUPPORTED_API_VERSIONS) + 1) } });
    expect(newer.status).toBe(426);
    const body = (await newer.json()) as { code: string; message: string; supportedVersions: number[] };
    expect(body.code).toBe('api_version_unsupported');
    expect(body.message).toMatch(/Update the server/);
    expect(body.supportedVersions).toEqual([...SUPPORTED_API_VERSIONS]);

    const older = await fetch(`${url}/api/v1/auth/status`, { headers: { 'x-beatseam-api': '0' } });
    expect(older.status).toBe(426);
    expect(((await older.json()) as { message: string }).message).toMatch(/newer version of the app/);
    expect((await fetch(`${url}/api/v1/health`, { headers: { 'x-beatseam-api': 'banana' } })).status).toBe(426);
  });

  it('leaves non-API routes alone', async () => {
    const page = await fetch(`${url}/login`, { headers: { 'x-beatseam-api': '99' } });
    expect(page.status).not.toBe(426);
    expect(page.headers.get('x-beatseam-api-versions')).toBeNull();
  });
});

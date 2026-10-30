import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-hardening-'));
  for (const k of ['BPMIX_SETUP_TOKEN', 'BPMIX_ORIGIN']) delete process.env[k];
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_DATA_DIR: path.join(base, 'data'), BPMIX_AUTH_RATE_LIMIT: '1000' });
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

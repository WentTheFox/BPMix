import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { encodeTrackKey, type Page, type ScanFailureDto, type ScanJobDto, type ScanStatusDto } from '@bpmix/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ScanWorkers } from '../src/scanner/scanWorkers.js';
import { ScannerService } from '../src/scanner/scanner.service.js';
import { ANALYZE_FILE } from '../src/scanner/tokens.js';
import { realAnalyze, resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

let app: INestApplication;
let base: string;
let url: string;

let client: TestClient;
const get = (p: string) => client.fetch(p);
const json = async <T>(p: string): Promise<T> => (await get(p)).json() as Promise<T>;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-scanapi-'));
  await mkdir(path.join(base, 'Music'));
  for (const name of ['good.mp3', 'bad.mp3']) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(base, 'Music', name)]);
  }
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    BPMIX_LIBRARY_ROOT: base,
    BPMIX_SCAN_ON_START: 'false',
    BPMIX_SCAN_BACKOFF_MS: '0',
    BPMIX_SCAN_WORKERS: '2',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANALYZE_FILE)
    .useValue(async (absolutePath: string) => {
      if (path.basename(absolutePath) === 'bad.mp3') throw new Error('ffmpeg exited with 183: Invalid data found when processing input');
      return realAnalyze(absolutePath);
    })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
  await resetDatabase();
  client = (await setUpAdmin(url, createTestClock())).client;
  await app.get(ScannerService).scanAll();
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('scan observability API', () => {
  it('reports queue counts and worker stats', async () => {
    const status = await json<ScanStatusDto>('/api/v1/scan');
    expect(status.running).toBe(false);
    expect(status.jobs).toEqual({ pending: 0, retrying: 0, running: 0, done: 1, skipped: 1 });
    expect(status.last).toMatchObject({ roots: 1, tracks: 2, queued: 2, jobs: { done: 1, skipped: 1 } });
    expect(status.workers).toMatchObject({ workers: 2, succeeded: 1, failedAttempts: 3, skipped: 1, inFlight: 0 });
  });

  it('lists the skipped (hopeless) tracks with why', async () => {
    const page = await json<Page<ScanJobDto>>('/api/v1/scan/jobs');
    expect(page.items).toEqual([
      expect.objectContaining({
        trackId: encodeTrackKey('Music:bad.mp3'),
        relativePath: 'bad.mp3',
        state: 'SKIPPED',
        attempts: 3,
        lastErrorStage: 'analysis',
        lastError: expect.stringContaining('Invalid data found'),
      }),
    ]);
    expect((await json<Page<ScanJobDto>>('/api/v1/scan/jobs?state=DONE')).items.map((j) => j.relativePath)).toEqual(['good.mp3']);
    expect((await get('/api/v1/scan/jobs?state=NOPE')).status).toBe(400);
  });

  it('lists every failed attempt, newest first, optionally for one track', async () => {
    const failures = await json<ScanFailureDto[]>('/api/v1/scan/failures');
    expect(failures.map((f) => [f.relativePath, f.stage, f.attempt, f.willRetry])).toEqual([
      ['bad.mp3', 'analysis', 3, false],
      ['bad.mp3', 'analysis', 2, true],
      ['bad.mp3', 'analysis', 1, true],
    ]);
    expect(await json<ScanFailureDto[]>(`/api/v1/scan/failures?trackId=${encodeTrackKey('Music:good.mp3')}`)).toEqual([]);
    expect((await get('/api/v1/scan/failures?trackId=!!!')).status).toBe(400);
  });

  it('retries skipped tracks on request', async () => {
    const res = await client.fetch(`/api/v1/scan/retry?trackId=${encodeTrackKey('Music:bad.mp3')}`, { method: 'POST' });
    expect(await res.json()).toEqual({ requeued: 1 });
    await app.get(ScanWorkers).waitUntilSettled();
    // Still hopeless, so it burns another full set of attempts and lands back in SKIPPED.
    expect((await json<ScanStatusDto>('/api/v1/scan')).jobs.skipped).toBe(1);
    expect((await json<ScanFailureDto[]>('/api/v1/scan/failures')).length).toBe(6);
  });
});

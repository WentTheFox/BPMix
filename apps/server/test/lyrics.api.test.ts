import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { analyzeTrack } from '@bpmix/core';
import { encodeTrackKey, lyricsSchema } from '@bpmix/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/db/database.module.js';
import { decodeWithFfmpeg } from '../src/scanner/ffmpegDecoder.js';
import { ScannerService } from '../src/scanner/scanner.service.js';
import { ANALYZE_FILE } from '../src/scanner/tokens.js';
import { resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

let app: INestApplication;
let base: string;
let client: TestClient;

function tone(file: string, title: string, artist: string): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, file]);
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-lyrics-'));
  await mkdir(path.join(base, 'Music'), { recursive: true });
  await mkdir(path.join(base, 'Lyrics'), { recursive: true });
  tone(path.join(base, 'Music', 'Song One.mp3'), 'Song One', 'Ann');
  tone(path.join(base, 'Music', 'Song Two.mp3'), 'Song Two', 'Bob');
  await writeFile(path.join(base, 'Lyrics', 'Song One.lrc'), '[lang:pt]\n[00:01.00]ola\n[00:05.00]mundo\n');
  await writeFile(path.join(base, 'Lyrics', 'Song One.en.lrc'), '[00:01.10]hello\n[00:05.00]world\n');

  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_LYRICS_ROOTS: 'Lyrics', BPMIX_DATA_DIR: path.join(base, 'data') });
  delete process.env.BPMIX_ORIGIN;
  process.env.BPMIX_SETUP_TOKEN = 'none';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANALYZE_FILE)
    .useValue(async (absolutePath: string) => analyzeTrack(await decodeWithFfmpeg(absolutePath)))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', 'localhost');
  await resetDatabase(app.get(DatabaseService).prisma);
  client = (await setUpAdmin(url, createTestClock())).client;
  await app.get(ScannerService).scanAll();
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('GET /api/v1/tracks/:key/lyrics', () => {
  it('serves the matched lyrics parsed, with the translation lines attached', async () => {
    const res = await client.fetch(`/api/v1/tracks/${encodeTrackKey('Music:Song One.mp3')}/lyrics`);
    expect(res.status).toBe(200);
    const lyrics = lyricsSchema.parse(await res.json());
    expect(lyrics.synced).toBe(true);
    expect(lyrics.tags.lang).toBe('pt');
    expect(lyrics.lines).toEqual([
      { timeSeconds: 1, text: 'ola', translation: 'hello' },
      { timeSeconds: 5, text: 'mundo', translation: 'world' },
    ]);
  });

  it('is a 404 for a track with no lyrics, and needs a sign-in', async () => {
    expect((await client.fetch(`/api/v1/tracks/${encodeTrackKey('Music:Song Two.mp3')}/lyrics`)).status).toBe(404);
    const stranger = new TestClient(client.baseUrl);
    expect((await stranger.fetch(`/api/v1/tracks/${encodeTrackKey('Music:Song One.mp3')}/lyrics`)).status).toBe(401);
  });
});

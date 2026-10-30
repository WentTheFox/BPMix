import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createTestClock, setUpAdmin, setUpUser, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

let app: INestApplication;
let base: string;
let client: TestClient;
let url: string;
const clock = createTestClock();

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
  url = (await app.getUrl()).replace('[::1]', 'localhost');
  await resetDatabase(app.get(DatabaseService).prisma);
  client = (await setUpAdmin(url, clock)).client;
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

const key = (name: string) => encodeTrackKey(`Music:${name}.mp3`);
const put = (p: string, json: unknown) => client.fetch(p, { method: 'PUT', json });

describe('changing a track\'s lyrics', () => {
  it('lists the candidate files and what is assigned now', async () => {
    const res = await client.fetch(`/api/v1/tracks/${key('Song One')}/lyrics/source`);
    expect(res.status).toBe(200);
    const source = (await res.json()) as { assigned: string | null; candidates: { id: string; name: string }[] };
    expect(source.assigned).toBe('Lyrics:Song One.lrc');
    expect(source.candidates.map((c) => c.name).sort()).toEqual(['Song One.en.lrc', 'Song One.lrc']);
  });

  it('links a track to a lyrics file and unlinks it again, and the lyrics follow', async () => {
    expect((await put(`/api/v1/tracks/${key('Song Two')}/lyrics/assignment`, { lrcFileId: 'Lyrics:Song One.lrc' })).status).toBe(204);
    expect((await client.fetch(`/api/v1/tracks/${key('Song Two')}/lyrics`)).status).toBe(200);
    expect((await client.json<{ items: { hasLyrics: boolean }[] }>(`/api/v1/tracks?q=Song Two`)).items[0]!.hasLyrics).toBe(true);

    expect((await put(`/api/v1/tracks/${key('Song Two')}/lyrics/assignment`, { lrcFileId: null })).status).toBe(204);
    expect((await client.fetch(`/api/v1/tracks/${key('Song Two')}/lyrics`)).status).toBe(404);
    expect((await put(`/api/v1/tracks/${key('Song Two')}/lyrics/assignment`, { lrcFileId: 'Lyrics:nope.lrc' })).status).toBe(404);
  });

  it('writes edited lines into the assigned file, keeping its tags', async () => {
    const lines = [{ timeSeconds: 2.5, text: 'new one' }, { timeSeconds: 7, text: 'new two' }, { timeSeconds: null, text: 'plain' }];
    expect((await put(`/api/v1/tracks/${key('Song One')}/lyrics`, { lines })).status).toBe(204);
    const written = await readFile(path.join(base, 'Lyrics', 'Song One.lrc'), 'utf8');
    expect(written).toBe('[lang:pt]\n[00:02.50]new one\n[00:07.00]new two\nplain\n');
    const lyrics = lyricsSchema.parse(await (await client.fetch(`/api/v1/tracks/${key('Song One')}/lyrics`)).json());
    expect(lyrics.lines[0]).toMatchObject({ timeSeconds: 2.5, text: 'new one' });
  });

  it('refuses to save for a track with no lyrics file, and rejects malformed lines', async () => {
    const none = await put(`/api/v1/tracks/${key('Song Two')}/lyrics`, { lines: [{ timeSeconds: 1, text: 'x' }] });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: 'no_lyrics_assigned' });
    expect((await put(`/api/v1/tracks/${key('Song One')}/lyrics`, { lines: [{ timeSeconds: -3, text: 'x' }] })).status).toBe(400);
    expect((await put(`/api/v1/tracks/${key('Song One')}/lyrics`, { lines: 'no' })).status).toBe(400);
  });

  it('says so when the lyrics folder is read-only', async () => {
    await chmod(path.join(base, 'Lyrics', 'Song One.lrc'), 0o444);
    try {
      const res = await put(`/api/v1/tracks/${key('Song One')}/lyrics`, { lines: [{ timeSeconds: 1, text: 'x' }] });
      // (a user with write access regardless, e.g. root, can't be made read-only this way)
      if (process.getuid?.() !== 0) {
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'lyrics_read_only' });
      }
    } finally {
      await chmod(path.join(base, 'Lyrics', 'Song One.lrc'), 0o644);
    }
  });

  it('is for admins only', async () => {
    const { client: bob } = await setUpUser(client, url, clock, 'bob');
    expect((await bob.fetch(`/api/v1/tracks/${key('Song One')}/lyrics/source`)).status).toBe(403);
    expect((await bob.fetch(`/api/v1/tracks/${key('Song One')}/lyrics/assignment`, { method: 'PUT', json: { lrcFileId: null } })).status).toBe(403);
    expect((await bob.fetch(`/api/v1/tracks/${key('Song One')}/lyrics`, { method: 'PUT', json: { lines: [] } })).status).toBe(403);
    // Reading is for everyone.
    expect((await bob.fetch(`/api/v1/tracks/${key('Song One')}/lyrics`)).status).toBe(200);
  });
});

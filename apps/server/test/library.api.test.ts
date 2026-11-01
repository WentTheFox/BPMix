import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { analyzeTrack } from '@beatseam/core';
import { encodeTrackKey, type Page, type PlaylistDto, type TrackDto } from '@beatseam/api';
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
let url: string;

function tone(file: string, title: string, artist: string, hz: number): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, file]);
}

let client: TestClient;
const get = (p: string, init?: Parameters<TestClient['fetch']>[1]) => client.fetch(p, init);
const json = async <T>(p: string): Promise<T> => (await get(p)).json() as Promise<T>;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'beatseam-api-'));
  await mkdir(path.join(base, 'Music', 'Album'), { recursive: true });
  tone(path.join(base, 'Music', 'Album', 'alpha.mp3'), 'Alpha', 'Ann', 440);
  tone(path.join(base, 'Music', 'Album', 'beta.mp3'), '100% Beta', 'Bob', 330);
  tone(path.join(base, 'Music', 'gamma.mp3'), 'Gamma', 'Ann', 220);
  await writeFile(path.join(base, 'Music', 'List.m3u8'), '#EXTM3U\nAlbum/beta.mp3\nAlbum/alpha.mp3\n');

  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BEATSEAM_LIBRARY_ROOT: base, BEATSEAM_SCAN_ON_START: 'false' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // The production worker is a built file next to main.js; analyse in-process under test.
    .overrideProvider(ANALYZE_FILE)
    .useValue(async (absolutePath: string) => analyzeTrack(await decodeWithFfmpeg(absolutePath)))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');

  const { prisma } = app.get(DatabaseService);
  await resetDatabase(prisma);
  client = (await setUpAdmin(url, createTestClock())).client;
  await app.get(ScannerService).scanAll();
  await prisma.coverArt.create({ data: { fileId: 'Music:gamma.mp3', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } });
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('v1 library API', () => {
  it('lists roots', async () => {
    expect(await json('/api/v1/roots')).toEqual([{ id: 'Music', displayName: 'Music', kind: 'library' }]);
  });

  it('lists tracks with tags, duration, loudness and flags, ordered by id', async () => {
    const page = await json<Page<TrackDto>>('/api/v1/tracks');
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((t) => t.relativePath)).toEqual(['Album/alpha.mp3', 'Album/beta.mp3', 'gamma.mp3']);
    expect(page.items[0]).toMatchObject({
      id: encodeTrackKey('Music:Album/alpha.mp3'),
      rootId: 'Music',
      title: 'Alpha',
      artists: ['Ann'],
      missing: false,
      hasCover: false,
      hasLyrics: false,
    });
    expect(page.items[0]!.durationSeconds).toBeGreaterThan(2);
    expect(page.items[0]!.normalizationGain).toBeGreaterThan(0);
    expect(page.items[2]!.hasCover).toBe(true);
  });

  it('pages with a cursor and never repeats or skips a track', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<TrackDto> = await json(`/api/v1/tracks?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((t) => t.relativePath));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['Album/alpha.mp3', 'Album/beta.mp3', 'gamma.mp3']);
  });

  it('searches title, artist and path, treating LIKE wildcards literally', async () => {
    const titles = async (q: string) => (await json<Page<TrackDto>>(`/api/v1/tracks?q=${encodeURIComponent(q)}`)).items.map((t) => t.title);
    expect(await titles('gamma')).toEqual(['Gamma']);
    expect(await titles('ann')).toEqual(['Alpha', 'Gamma']);
    expect(await titles('album/')).toEqual(['Alpha', '100% Beta']);
    expect(await titles('100%')).toEqual(['100% Beta']);
    expect(await titles('%')).toEqual(['100% Beta']);
    expect(await titles('_lpha')).toEqual([]);
  });

  it('rejects bad queries and malformed keys, and 404s unknown ones', async () => {
    expect((await get('/api/v1/tracks?limit=100000')).status).toBe(400);
    expect((await get('/api/v1/tracks/!!!')).status).toBe(400);
    expect((await get(`/api/v1/tracks/${encodeTrackKey('Music:nope.mp3')}`)).status).toBe(404);
    expect((await get(`/api/v1/tracks/${encodeTrackKey('Music:nope.mp3')}/stream`)).status).toBe(404);
  });

  it('streams the original file with Range support', async () => {
    const key = encodeTrackKey('Music:gamma.mp3');
    const full = await get(`/api/v1/tracks/${key}/stream`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-type')).toMatch(/audio\/mpeg/);
    const size = (await full.arrayBuffer()).byteLength;

    const part = await get(`/api/v1/tracks/${key}/stream`, { headers: { Range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it('serves cover art, and 404s when a track has none', async () => {
    const cover = await get(`/api/v1/tracks/${encodeTrackKey('Music:gamma.mp3')}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toMatch(/image\/png/);
    expect(Array.from(new Uint8Array(await cover.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await get(`/api/v1/tracks/${encodeTrackKey('Music:Album/alpha.mp3')}/cover`)).status).toBe(404);
  });

  it('lists playlists with track keys in play order', async () => {
    const playlists = await json<PlaylistDto[]>('/api/v1/playlists');
    expect(playlists).toEqual([
      {
        id: encodeTrackKey('Music:List.m3u8'),
        rootId: 'Music',
        name: 'List',
        trackIds: [encodeTrackKey('Music:Album/beta.mp3'), encodeTrackKey('Music:Album/alpha.mp3')],
      },
    ]);
    expect(await json(`/api/v1/playlists/${playlists[0]!.id}`)).toEqual(playlists[0]);
    expect((await get(`/api/v1/playlists/${encodeTrackKey('Music:nope.m3u8')}`)).status).toBe(404);
  });
});

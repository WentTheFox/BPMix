import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { encodeTrackKey, type Page, type SyncChangesResponseDto, type SyncSnapshotResponseDto, type TrackDto } from '@bpmix/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { ScannerService } from '../src/scanner/scanner.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { ANALYZE_FILE } from '../src/scanner/tokens.js';
import { LocalReplica, sorted } from './replica.js';
import { realAnalyze, resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let prisma: DatabaseService['prisma'];
let admin: TestClient;

async function serverTracks(): Promise<Map<string, TrackDto>> {
  const all = new Map<string, TrackDto>();
  let cursor: string | null = null;
  do {
    const page: Page<TrackDto> = await admin.json(`/api/v1/tracks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const track of page.items) all.set(track.id, track);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-sync-'));
  await mkdir(path.join(base, 'Music', 'Album'), { recursive: true });
  for (const [file, hz] of [['Album/a.mp3', 220], ['Album/b.mp3', 330], ['c.mp3', 440], ['d.mp3', 550]] as const) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=1`, '-metadata', `title=${file}`, path.join(base, 'Music', file)]);
  }
  await writeFile(path.join(base, 'Music', 'List.m3u8'), '#EXTM3U\nAlbum/b.mp3\nAlbum/a.mp3\n');
  for (const key of ['BPMIX_SETUP_TOKEN', 'BPMIX_ORIGIN']) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_DATA_DIR: path.join(base, 'data'), BPMIX_AUTH_RATE_LIMIT: '1000', BPMIX_SCAN_BACKOFF_MS: '0' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock.now)
    .overrideProvider(ANALYZE_FILE)
    .useValue(realAnalyze)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
  prisma = app.get(DatabaseService).prisma;
}, 60_000);

beforeEach(async () => {
  await resetDatabase(prisma);
  await prisma.change.deleteMany();
  await prisma.keyValue.deleteMany();
  admin = (await setUpAdmin(url, createTestClock())).client;
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('sync feed', () => {
  it('needs a sign-in, and works for a native app token too', async () => {
    expect((await new TestClient(url).fetch('/api/v1/sync/changes?since=0')).status).toBe(401);
    expect((await admin.fetch('/api/v1/sync/changes?since=0')).status).toBe(200);
    expect((await admin.fetch('/api/v1/sync/changes?since=abc')).status).toBe(400);
    expect((await admin.fetch('/api/v1/sync/changes')).status).toBe(400);
  });

  it('starts from a snapshot that matches the server, then follows deltas', async () => {
    await app.get(ScannerService).scanAll();
    const replica = new LocalReplica();
    await replica.checkIn(admin);

    expect(replica.tracks.size).toBe(4);
    expect(sorted(replica.tracks)).toEqual(sorted(await serverTracks()));
    expect([...replica.playlists.values()].map((p) => [p.name, p.trackIds.length])).toEqual([['List', 2]]);
    expect(replica.roots.map((r) => r.id)).toContain('Music');

    // Nothing happened since: the next check-in is a single cheap request that changes nothing.
    const before = replica.requests;
    const cursorBefore = replica.cursor;
    await replica.checkIn(admin);
    expect(replica.requests - before).toBe(1);
    expect(replica.cursor).toBe(cursorBefore);
  });

  it('pages a snapshot without repeating or dropping anything, whatever the page size', async () => {
    await app.get(ScannerService).scanAll();
    for (const limit of [1, 2, 3, 4, 5, 500]) {
      const replica = new LocalReplica();
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await admin.json<SyncSnapshotResponseDto>(`/api/v1/sync/snapshot?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        seen.push(...page.entities.map((e) => `${e.entity}:${e.id}`));
        replica.apply(page.entities);
        after = page.next ?? undefined;
      } while (after);
      expect(seen.length, `limit ${limit}`).toBe(5); // 4 tracks + 1 playlist
      expect(new Set(seen).size, `limit ${limit}`).toBe(5);
      expect(replica.tracks.size).toBe(4);
      expect(replica.playlists.size).toBe(1);
    }
  });

  it('sends each changed entity once, as its latest state, and a tombstone for what was removed', async () => {
    await app.get(ScannerService).scanAll();
    const replica = new LocalReplica();
    await replica.checkIn(admin);

    const key = encodeTrackKey('Music:c.mp3');
    // Several changes to one track (and one track's removal) between check-ins.
    await prisma.trackMetadata.update({ where: { fileId: 'Music:c.mp3' }, data: { title: 'First edit' } });
    await prisma.trackMetadata.update({ where: { fileId: 'Music:c.mp3' }, data: { title: 'Second edit' } });
    await prisma.lyricsAssignment.create({ data: { fileId: 'Music:c.mp3', lrcFileId: 'Lyrics:c.lrc' } });
    await prisma.track.delete({ where: { fileId: 'Music:d.mp3' } });

    const page = await admin.json<SyncChangesResponseDto>(`/api/v1/sync/changes?since=${replica.cursor}`);
    expect(page.hasMore).toBe(false);
    expect(page.changes).toHaveLength(2);
    const changed = page.changes.find((c) => c.entity === 'track' && c.id === key);
    expect(changed).toMatchObject({ track: { title: 'Second edit', hasLyrics: true } });
    expect(page.changes.find((c) => c.entity === 'track' && c.id === encodeTrackKey('Music:d.mp3'))).toEqual({ entity: 'track', id: encodeTrackKey('Music:d.mp3'), track: null });

    await replica.checkIn(admin);
    expect(sorted(replica.tracks)).toEqual(sorted(await serverTracks()));
    expect(replica.tracks.has(encodeTrackKey('Music:d.mp3'))).toBe(false);
  });

  it('does not re-send a track when a write changed nothing', async () => {
    await app.get(ScannerService).scanAll();
    const { cursor } = await admin.json<SyncChangesResponseDto>('/api/v1/sync/changes?since=0');
    await prisma.trackMetadata.update({ where: { fileId: 'Music:c.mp3' }, data: { title: 'Same' } });
    const afterEdit = (await admin.json<SyncChangesResponseDto>(`/api/v1/sync/changes?since=${cursor}`)).cursor;
    await prisma.trackMetadata.update({ where: { fileId: 'Music:c.mp3' }, data: { title: 'Same' } });
    expect((await admin.json<SyncChangesResponseDto>(`/api/v1/sync/changes?since=${afterEdit}`)).changes).toEqual([]);
  });

  it('pages deltas in order with hasMore, and the pages add up to the whole change set', async () => {
    await app.get(ScannerService).scanAll();
    const replica = new LocalReplica();
    await replica.checkIn(admin);
    for (const file of ['Album/a.mp3', 'Album/b.mp3', 'c.mp3', 'd.mp3']) {
      await prisma.trackMetadata.update({ where: { fileId: `Music:${file}` }, data: { album: `edited ${file}` } });
    }
    const first = await admin.json<SyncChangesResponseDto>(`/api/v1/sync/changes?since=${replica.cursor}&limit=3`);
    expect(first.hasMore).toBe(true);
    expect(first.changes).toHaveLength(3);
    const second = await admin.json<SyncChangesResponseDto>(`/api/v1/sync/changes?since=${first.cursor}&limit=3`);
    expect(second.hasMore).toBe(false);
    expect(second.changes).toHaveLength(1);

    await replica.checkIn(admin, 2);
    expect(sorted(replica.tracks)).toEqual(sorted(await serverTracks()));
  });

  it('demands a resync for a cursor from before the trimmed history, or from a different database', async () => {
    await app.get(ScannerService).scanAll();
    const { cursor } = await admin.json<SyncChangesResponseDto>('/api/v1/sync/changes?since=0');
    const stale = await admin.fetch('/api/v1/sync/changes?since=0');
    expect(stale.status).toBe(200); // history still covers it

    await prisma.change.updateMany({ data: { at: new Date(Date.now() - 100 * 24 * 60 * 60_000) } });
    await prisma.trackMetadata.update({ where: { fileId: 'Music:c.mp3' }, data: { title: 'recent' } });
    expect(await app.get(SyncService).compact()).toBeGreaterThan(0);

    const gone = await admin.fetch('/api/v1/sync/changes?since=0');
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ code: 'resync_required' });
    expect((await admin.fetch(`/api/v1/sync/changes?since=${BigInt(cursor) + 1000n}`)).status).toBe(410); // from the future
    // A cursor at or past the floor is still fine, and the recent change survived.
    expect((await admin.json<SyncChangesResponseDto>(`/api/v1/sync/changes?since=${cursor}`)).changes.length).toBe(1);

    // A client that hits the 410 recovers on its own, with a snapshot.
    const replica = new LocalReplica();
    replica.cursor = '0';
    await replica.checkIn(admin);
    expect(sorted(replica.tracks)).toEqual(sorted(await serverTracks()));
  });

  it('converges to the server after any mix of adds, edits and removals, however it is chunked', async () => {
    await app.get(ScannerService).scanAll();
    const replica = new LocalReplica();
    await replica.checkIn(admin, 2);

    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ids = Array.from({ length: 12 }, (_, i) => `Music:gen/${String(i).padStart(2, '0')}.mp3`);
    for (let round = 0; round < 15; round++) {
      for (let op = 0; op < 1 + Math.floor(random() * 6); op++) {
        const fileId = ids[Math.floor(random() * ids.length)]!;
        const roll = random();
        if (roll < 0.45) {
          await prisma.track.upsert({ where: { fileId }, create: { fileId, rootId: 'Music', relativePath: fileId.slice(6), sizeBytes: 1n, lastModifiedMs: round }, update: { lastModifiedMs: round } });
        } else if (roll < 0.75) {
          await prisma.trackMetadata.upsert({ where: { fileId }, create: { fileId, title: `t${round}`, artists: [], sizeBytes: 1n, lastModifiedMs: 1, parserVersion: 1 }, update: { title: `t${round}-${op}` } });
        } else {
          await prisma.track.deleteMany({ where: { fileId } });
        }
      }
      if (random() < 0.6) await replica.checkIn(admin, 1 + Math.floor(random() * 4)); // sometimes skip a round: bigger gaps
    }
    await replica.checkIn(admin, 3);
    expect(sorted(replica.tracks)).toEqual(sorted(await serverTracks()));
  });

  it('cannot skip a slow transaction that commits after a faster, later one (deterministic)', async () => {
    const replica = new LocalReplica();
    await replica.checkIn(admin);
    const make = (name: string) => ({ fileId: `Music:order/${name}.mp3`, rootId: 'Music', relativePath: `order/${name}.mp3`, sizeBytes: 1n, lastModifiedMs: 1 });
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // `slow` takes its revision first but commits last...
    const slow = prisma.$transaction(async (tx) => {
      await tx.track.create({ data: make('slow') });
      await gate;
    });
    await pause(150);
    // ...while `fast` starts later. Revisions are handed out in commit order, so `fast` has to wait for `slow`.
    const fast = prisma.$transaction(async (tx) => {
      await tx.track.create({ data: make('fast') });
    });
    await pause(150);

    await replica.checkIn(admin); // a client checks in while `slow` is still open
    expect([...replica.tracks.values()].map((t) => t.relativePath)).toEqual([]);
    release();
    await Promise.all([slow, fast]);

    await replica.checkIn(admin);
    expect([...replica.tracks.values()].map((t) => t.relativePath).sort()).toEqual(['order/fast.mp3', 'order/slow.mp3']);
  });

  it('never misses a change that commits out of order while a client is reading', async () => {
    const replica = new LocalReplica();
    await replica.checkIn(admin);
    const ids = Array.from({ length: 24 }, (_, i) => `Music:race/${String(i).padStart(2, '0')}.mp3`);
    let writersDone = false;

    // Transactions of very different durations, started together: without ordered revisions, a quick
    // one would commit a higher rev before a slow one commits a lower one, and a reader in between
    // would advance past the slow one for good.
    const writers = Promise.all(
      ids.map((fileId, i) =>
        prisma.$transaction(async (tx) => {
          await tx.track.create({ data: { fileId, rootId: 'Music', relativePath: fileId.slice(6), sizeBytes: 1n, lastModifiedMs: i } });
          await tx.$executeRaw`SELECT pg_sleep(${((i * 7) % 11) / 100})`;
        }),
      ),
    ).finally(() => {
      writersDone = true;
    });

    const reading = (async () => {
      while (!writersDone) {
        await replica.checkIn(admin, 5);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    await Promise.all([writers, reading]);
    await replica.checkIn(admin);

    expect([...replica.tracks.keys()].filter((k) => k.length > 0).length).toBe(24);
    expect(sorted(replica.tracks)).toEqual(sorted(await serverTracks()));
  });
});

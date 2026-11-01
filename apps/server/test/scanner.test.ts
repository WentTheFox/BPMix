import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScannerService } from '../src/scanner/scanner.service.js';
import { createScanStack, resetDatabase, testPrisma, type ScanStack } from './scanStack.js';

const prisma = testPrisma;
let base: string;
const stacks: ScanStack[] = [];

function tone(file: string, title: string, hz: number): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-metadata', `title=${title}`, '-metadata', 'artist=Test Artist', file]);
}

async function makeScanner(): Promise<ScannerService> {
  const stack = await createScanStack({ base });
  stacks.push(stack);
  return stack.scanner;
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'beatseam-scan-'));
  await mkdir(path.join(base, 'Music', 'Album'), { recursive: true });
  await mkdir(path.join(base, 'Lyrics'));
});

beforeEach(async () => {
  await resetDatabase();
  tone(path.join(base, 'Music', 'Album', 'one.mp3'), 'One', 440);
  tone(path.join(base, 'Music', 'two.mp3'), 'Two', 220);
  // Ogg is a format core's header parser can't read a duration from, so this exercises the ffprobe fallback.
  tone(path.join(base, 'Music', 'three.ogg'), 'Three', 330);
  await writeFile(path.join(base, 'Music', 'List.m3u8'), '#EXTM3U\nAlbum/one.mp3\nmissing/gone.mp3\n');
  await writeFile(path.join(base, 'Lyrics', 'one.lrc'), '[00:00.00]hello\n[00:01.00]world\n');
});

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.stop()));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(base, { recursive: true, force: true });
});

describe('ScannerService', () => {
  it('registers every audio file, reads tags, measures loudness and matches lyrics', async () => {
    const summary = await (await makeScanner()).scanAll();
    expect(summary).toMatchObject({ roots: 1, queued: 3, jobs: { done: 3, skipped: 0, retrying: 0 } });

    const tracks = await prisma.track.findMany({ orderBy: { relativePath: 'asc' } });
    // Both real files (one playlisted, one not) plus the playlist's missing placeholder.
    expect(tracks.map((t) => [t.relativePath, t.missing])).toEqual([
      ['Album/one.mp3', false],
      ['missing/gone.mp3', true],
      ['three.ogg', false],
      ['two.mp3', false],
    ]);

    const ogg = await prisma.trackMetadata.findUnique({ where: { fileId: 'Music:three.ogg' } });
    expect(ogg?.durationSeconds).toBeGreaterThan(2);

    const metadata = await prisma.trackMetadata.findUnique({ where: { fileId: 'Music:Album/one.mp3' } });
    expect(metadata).toMatchObject({ title: 'One', artists: ['Test Artist'] });
    expect(metadata?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata?.durationSeconds).toBeGreaterThan(2);
    expect((await prisma.trackAnalysis.findUnique({ where: { fileId: 'Music:two.mp3' } }))?.normalizationGain).toBeGreaterThan(0);
    expect(await prisma.playlist.findMany()).toMatchObject([{ name: 'List', trackFileIds: ['Music:Album/one.mp3', 'missing:Music:missing/gone.mp3'] }]);
    expect(await prisma.lyricsAssignment.findUnique({ where: { fileId: 'Music:Album/one.mp3' } })).toMatchObject({ lrcFileId: 'Lyrics:one.lrc' });
  });

  it('drops tracks and their derived rows when the file disappears', async () => {
    const scanner = await makeScanner();
    await scanner.scanAll();
    await unlink(path.join(base, 'Music', 'two.mp3'));
    await scanner.scanAll();
    expect(await prisma.track.findUnique({ where: { fileId: 'Music:two.mp3' } })).toBeNull();
    expect(await prisma.trackMetadata.findUnique({ where: { fileId: 'Music:two.mp3' } })).toBeNull();
    expect(await prisma.trackAnalysis.findUnique({ where: { fileId: 'Music:two.mp3' } })).toBeNull();
  });

  it('drops a lyrics scope whose root is gone instead of failing or hanging the scan', async () => {
    await prisma.lyricsScope.create({ data: { rootId: 'Unmounted', relativePath: '' } });
    const summary = await (await makeScanner()).scanAll();
    expect(summary.tracks).toBe(3);
    expect(await prisma.lyricsScope.findMany({ where: { rootId: 'Unmounted' } })).toEqual([]);
  });

  it('joins a scan that is already running instead of starting another', async () => {
    const scanner = await makeScanner();
    const first = scanner.scanAll();
    expect((await scanner.status()).running).toBe(true);
    expect(scanner.scanAll()).toBe(first);
    await first;
    expect((await scanner.status()).running).toBe(false);
  });
});

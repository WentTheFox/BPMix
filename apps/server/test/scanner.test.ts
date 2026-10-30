import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeTrack } from '@bpmix/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../src/db/prisma.js';
import { createPrismaLibraryStore } from '../src/db/prismaLibraryStore.js';
import { decodeWithFfmpeg } from '../src/scanner/ffmpegDecoder.js';
import { ScannerService } from '../src/scanner/scanner.service.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const prisma = createPrismaClient(TEST_DATABASE_URL);
let base: string;

function tone(file: string, title: string, hz: number): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-metadata', `title=${title}`, '-metadata', 'artist=Test Artist', file]);
}

function makeScanner(): ScannerService {
  const db = { prisma, libraryStore: createPrismaLibraryStore(prisma) };
  const env: Record<string, string> = { BPMIX_LIBRARY_ROOT: base, BPMIX_LYRICS_ROOTS: 'Lyrics' };
  // In-process analysis; production runs the same decode+analyze on a worker thread.
  const analyze = async (absolutePath: string) => analyzeTrack(await decodeWithFfmpeg(absolutePath));
  return new ScannerService(db as never, { get: (key: string) => env[key] } as never, analyze);
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-scan-'));
  await mkdir(path.join(base, 'Music', 'Album'), { recursive: true });
  await mkdir(path.join(base, 'Lyrics'));
});

beforeEach(async () => {
  await prisma.$transaction([
    prisma.track.deleteMany(),
    prisma.playlist.deleteMany(),
    prisma.trackMetadata.deleteMany(),
    prisma.trackAnalysis.deleteMany(),
    prisma.coverArt.deleteMany(),
    prisma.lyricsScope.deleteMany(),
    prisma.lyricsAssignment.deleteMany(),
  ]);
  tone(path.join(base, 'Music', 'Album', 'one.mp3'), 'One', 440);
  tone(path.join(base, 'Music', 'two.mp3'), 'Two', 220);
  await writeFile(path.join(base, 'Music', 'List.m3u8'), '#EXTM3U\nAlbum/one.mp3\nmissing/gone.mp3\n');
  await writeFile(path.join(base, 'Lyrics', 'one.lrc'), '[00:00.00]hello\n[00:01.00]world\n');
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(base, { recursive: true, force: true });
});

describe('ScannerService', () => {
  it('registers every audio file, reads tags, measures loudness and matches lyrics', async () => {
    const summary = await makeScanner().scanAll();
    expect(summary).toMatchObject({ roots: 1, metadataFailures: 0, analysisFailures: 0 });

    const tracks = await prisma.track.findMany({ orderBy: { relativePath: 'asc' } });
    // Both real files (one playlisted, one not) plus the playlist's missing placeholder.
    expect(tracks.map((t) => [t.relativePath, t.missing])).toEqual([
      ['Album/one.mp3', false],
      ['missing/gone.mp3', true],
      ['two.mp3', false],
    ]);

    const metadata = await prisma.trackMetadata.findUnique({ where: { fileId: 'Music:Album/one.mp3' } });
    expect(metadata).toMatchObject({ title: 'One', artists: ['Test Artist'] });
    expect(metadata?.durationSeconds).toBeGreaterThan(2);
    expect((await prisma.trackAnalysis.findUnique({ where: { fileId: 'Music:two.mp3' } }))?.normalizationGain).toBeGreaterThan(0);
    expect(await prisma.playlist.findMany()).toMatchObject([{ name: 'List', trackFileIds: ['Music:Album/one.mp3', 'missing:Music:missing/gone.mp3'] }]);
    expect(await prisma.lyricsAssignment.findUnique({ where: { fileId: 'Music:Album/one.mp3' } })).toMatchObject({ lrcFileId: 'Lyrics:one.lrc' });
  });

  it('drops tracks and their derived rows when the file disappears', async () => {
    const scanner = makeScanner();
    await scanner.scanAll();
    await unlink(path.join(base, 'Music', 'two.mp3'));
    await scanner.scanAll();
    expect(await prisma.track.findUnique({ where: { fileId: 'Music:two.mp3' } })).toBeNull();
    expect(await prisma.trackMetadata.findUnique({ where: { fileId: 'Music:two.mp3' } })).toBeNull();
    expect(await prisma.trackAnalysis.findUnique({ where: { fileId: 'Music:two.mp3' } })).toBeNull();
  });

  it('joins a scan that is already running instead of starting another', async () => {
    const scanner = makeScanner();
    const first = scanner.scanAll();
    expect(scanner.status().running).toBe(true);
    expect(scanner.scanAll()).toBe(first);
    await first;
    expect(scanner.status().running).toBe(false);
  });
});

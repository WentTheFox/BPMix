import { analyzeTrack, type TrackAnalysis } from '@bpmix/core';
import type { DatabaseService } from '../src/db/database.module.js';
import { createPrismaClient, type PrismaClient } from '../src/db/prisma.js';
import { createPrismaLibraryStore } from '../src/db/prismaLibraryStore.js';
import { createNodeFileAccess } from '../src/node/nodeFileAccess.js';
import { decodeWithFfmpeg } from '../src/scanner/ffmpegDecoder.js';
import { ScanWorkers } from '../src/scanner/scanWorkers.js';
import { ScannerService } from '../src/scanner/scanner.service.js';
import { TrackProcessor } from '../src/scanner/trackProcessor.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

export const testPrisma = createPrismaClient(TEST_DATABASE_URL);

export async function resetDatabase(prisma: PrismaClient = testPrisma): Promise<void> {
  await prisma.$transaction([
    prisma.track.deleteMany(),
    prisma.playlist.deleteMany(),
    prisma.trackMetadata.deleteMany(),
    prisma.trackAnalysis.deleteMany(),
    prisma.coverArt.deleteMany(),
    prisma.lyricsScope.deleteMany(),
    prisma.lyricsAssignment.deleteMany(),
    prisma.trackJob.deleteMany(),
    prisma.trackJobFailure.deleteMany(),
    prisma.keyValue.deleteMany(),
    // Users cascade to their credentials, recovery codes, sessions, device tokens and invites.
    prisma.appliedMutation.deleteMany(),
    prisma.user.deleteMany(),
    prisma.authChallenge.deleteMany(),
    prisma.deviceGrant.deleteMany(),
  ]);
}

export type AnalyzeFn = (absolutePath: string) => Promise<TrackAnalysis>;

/** Decodes and analyses in-process; production does the same on a worker thread. */
export const realAnalyze: AnalyzeFn = async (absolutePath) => analyzeTrack(await decodeWithFfmpeg(absolutePath));

export interface ScanStack {
  scanner: ScannerService;
  workers: ScanWorkers;
  stop(): Promise<void>;
}

/** The scanner and its worker pool, wired by hand (no Nest container), against the shared test database. */
export async function createScanStack(options: {
  base: string;
  analyze?: AnalyzeFn;
  /** Config overrides, e.g. BPMIX_SCAN_WORKERS. Retries are due immediately (0ms backoff) unless overridden: the scan only waits for jobs that are due, so a nonzero backoff would make it race the retries. */
  env?: Record<string, string>;
}): Promise<ScanStack> {
  const env: Record<string, string> = { BPMIX_SCAN_WORKERS: '2', BPMIX_SCAN_BACKOFF_MS: '0', ...options.env };
  const config = { get: (key: string) => env[key] } as never;
  const db = { prisma: testPrisma, libraryStore: createPrismaLibraryStore(testPrisma), connectionString: TEST_DATABASE_URL } as unknown as DatabaseService;
  const fileAccess = createNodeFileAccess(options.base, new Set(['Lyrics']));
  const processor = new TrackProcessor(db, fileAccess, options.analyze ?? realAnalyze);
  const workers = new ScanWorkers(db, processor, config);
  await workers.start();
  const scanner = new ScannerService(db, config, fileAccess, workers);
  return { scanner, workers, stop: () => workers.stop() };
}

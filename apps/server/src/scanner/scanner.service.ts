import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { encodeTrackKey, type ScanFailureDto, type ScanJobDto } from '@bpmix/api';
import { isAudioFileName, matchLibraryLyrics, pruneOrphanedRootData, scanRoot, walkDirectory, type LyricsScope } from '@bpmix/core';
import { DatabaseService } from '../db/database.module.js';
import { FILE_ACCESS, type NodeFileAccess } from '../node/node.module.js';
import type { JobCounts, JobSummary } from './jobQueue.js';
import { ScanWorkers, type WorkerStats } from './scanWorkers.js';
import { ANALYZE_FILE } from './tokens.js';
import { trackFingerprint } from './trackProcessor.js';

export { ANALYZE_FILE };

export interface ScanSummary {
  startedAtMs: number;
  finishedAtMs: number;
  roots: number;
  tracks: number;
  /** Tracks (re)queued by this scan because they were new or changed. */
  queued: number;
  /** Queue state when this scan settled. Skipped tracks failed every attempt and are left alone until they change or are retried. */
  jobs: JobCounts;
}

export interface ScanStatus {
  running: boolean;
  last: ScanSummary | null;
  jobs: JobCounts;
  workers: WorkerStats;
}

const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Server-side library scan, in two parts. Discovery (here) walks each root and
 * registers every audio file as a track, then queues a per-track job for each
 * new or changed one. The per-track work - tags, cover art, duration, hash,
 * loudness - is done by the ScanWorkers pool off that queue, with retries; a
 * track that keeps failing is skipped until it changes. When the queue
 * settles, lyrics are matched across the library (they need every track).
 * Everything runs @bpmix/core's own scan code against the Node FileAccess and
 * the Postgres LibraryStore, so clients never have to.
 */
@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);
  private current: Promise<ScanSummary> | null = null;
  private last: ScanSummary | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    @Inject(FILE_ACCESS) private readonly fileAccess: NodeFileAccess,
    private readonly workers: ScanWorkers,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('BPMIX_SCAN_ON_START') === 'false') return;
    void this.scanAll().catch((err: unknown) => this.logger.error(`Startup scan failed: ${String(err)}`));
  }

  /** Safety net for changes no one triggered a scan for (e.g. a network mount without change events). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  scheduledScan(): void {
    void this.scanAll().catch((err: unknown) => this.logger.error(`Scheduled scan failed: ${String(err)}`));
    void this.workers.queue
      .pruneFailures(new Date(Date.now() - FAILURE_RETENTION_MS))
      .catch((err: unknown) => this.logger.warn(`Pruning old failures failed: ${String(err)}`));
  }

  async status(): Promise<ScanStatus> {
    return { running: this.current !== null, last: this.last, jobs: await this.workers.queue.counts(), workers: this.workers.getStats() };
  }

  async listJobs(state: JobSummary['state'], limit: number, cursor?: string): Promise<{ items: ScanJobDto[]; nextCursor: string | null }> {
    const jobs = await this.workers.queue.list(state, limit + 1, cursor);
    const page = jobs.slice(0, limit);
    const paths = await this.relativePaths(page.map((j) => j.fileId));
    return {
      items: page.map((j) => ({
        trackId: encodeTrackKey(j.fileId),
        relativePath: paths.get(j.fileId) ?? null,
        state: j.state,
        attempts: j.attempts,
        lastError: j.lastError,
        lastErrorStage: j.lastErrorStage,
        skippedAtMs: j.skippedAt?.getTime() ?? null,
        updatedAtMs: j.updatedAt.getTime(),
      })),
      nextCursor: jobs.length > limit ? page[page.length - 1]!.fileId : null,
    };
  }

  async listFailures(limit: number, fileId?: string): Promise<ScanFailureDto[]> {
    const failures = await this.workers.queue.listFailures(limit, fileId);
    const paths = await this.relativePaths(failures.map((f) => f.fileId));
    return failures.map((f) => ({
      id: f.id,
      trackId: encodeTrackKey(f.fileId),
      relativePath: paths.get(f.fileId) ?? null,
      stage: f.stage,
      attempt: f.attempt,
      error: f.error,
      willRetry: f.willRetry,
      workerId: f.workerId,
      atMs: f.at.getTime(),
    }));
  }

  /** Gives skipped tracks (one, or all) a fresh set of attempts, e.g. after fixing ffmpeg or the file. */
  retrySkipped(fileId?: string): Promise<number> {
    return this.workers.queue.retrySkipped(fileId);
  }

  private async relativePaths(fileIds: string[]): Promise<Map<string, string>> {
    const rows = await this.db.prisma.track.findMany({ where: { fileId: { in: fileIds } }, select: { fileId: true, relativePath: true } });
    return new Map(rows.map((r) => [r.fileId, r.relativePath]));
  }

  /** Starts a scan, or joins the one already running - two overlapping scans would just fight over the same rows. */
  scanAll(): Promise<ScanSummary> {
    if (this.current) return this.current;
    const run = this.runScan().finally(() => {
      this.current = null;
    });
    this.current = run;
    return run;
  }

  /**
   * scanRoot only records tracks some .m3u8 references (the clients' model, where
   * the rest are "unplaylisted" extras they discover separately). The server's
   * library is every audio file under the root, playlisted or not, so register
   * the rest here and drop rows whose file is gone (playlist-referenced
   * `missing` placeholders stay - they're deliberate).
   */
  private async syncAudioFiles(rootId: string): Promise<void> {
    const store = this.db.libraryStore;
    const { files } = await walkDirectory(this.fileAccess, rootId);
    const known = new Map((await store.listTracks(rootId)).map((t) => [t.relativePath, t]));
    const walked = new Set<string>();
    for (const file of files) {
      // walkDirectory returns every file (playlists, lyrics, cover images, ...), not just audio.
      if (!isAudioFileName(file.name)) continue;
      walked.add(file.relativePath);
      const existing = known.get(file.relativePath);
      if (existing && !existing.missing && existing.sizeBytes === file.sizeBytes && existing.lastModifiedMs === file.lastModifiedMs) continue;
      await store.upsertTrack({
        fileId: file.id,
        rootId,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        lastModifiedMs: file.lastModifiedMs,
      });
      // The real file resolved: a stale `missing:` placeholder for the same path is dead weight.
      if (existing && existing.fileId !== file.id) await store.deleteTrack(existing.fileId);
    }
    for (const [relativePath, track] of known) {
      if (!track.missing && !walked.has(relativePath)) await store.deleteTrack(track.fileId);
    }
  }

  /** Removes per-file rows whose track no longer exists (LibraryStore has no per-table deletes, and no FKs - see schema.prisma). */
  private async sweepOrphans(): Promise<void> {
    const { prisma } = this.db;
    await prisma.$transaction([
      prisma.$executeRaw`DELETE FROM track_metadata WHERE file_id NOT IN (SELECT file_id FROM tracks)`,
      prisma.$executeRaw`DELETE FROM track_analysis WHERE file_id NOT IN (SELECT file_id FROM tracks)`,
      prisma.$executeRaw`DELETE FROM cover_art WHERE file_id NOT IN (SELECT file_id FROM tracks)`,
      prisma.$executeRaw`DELETE FROM lyrics_assignments WHERE file_id NOT IN (SELECT file_id FROM tracks)`,
      prisma.$executeRaw`DELETE FROM track_jobs WHERE state <> 'RUNNING' AND file_id NOT IN (SELECT file_id FROM tracks)`,
    ]);
  }

  private async runScan(): Promise<ScanSummary> {
    const startedAtMs = Date.now();
    const store = this.db.libraryStore;
    const roots = await this.fileAccess.listGrantedRoots();
    const libraryRoots = roots.filter((r) => r.kind !== 'lyrics');
    const lyricsRoots = roots.filter((r) => r.kind === 'lyrics');
    this.logger.log(`Scan started: ${libraryRoots.length} library root(s), ${lyricsRoots.length} lyrics root(s)`);

    // Lyrics roots are scopes of their own, mirroring what the clients' refresh() used to register.
    const existingScopes = await store.getLyricsScopes();
    for (const root of lyricsRoots) {
      if (!existingScopes.some((s) => s.rootId === root.id && s.relativePath === '')) {
        await store.addLyricsScope({ rootId: root.id, relativePath: '' });
      }
    }
    // A scope whose volume was unmounted or renamed would make every lyrics match fail.
    const rootIds = new Set(roots.map((r) => r.id));
    for (const scope of existingScopes) {
      if (!rootIds.has(scope.rootId)) await store.removeLyricsScope(scope.rootId, scope.relativePath);
    }

    for (const root of libraryRoots) {
      await scanRoot(this.fileAccess, store, root.id);
      await this.syncAudioFiles(root.id);
    }
    await pruneOrphanedRootData(store, roots.map((r) => r.id));
    await this.sweepOrphans();

    const tracks = (await store.listAllTracks()).filter((t) => !t.missing);
    const queued = await this.workers.queue.enqueue(tracks.map((t) => ({ fileId: t.fileId, fingerprint: trackFingerprint(t) })));
    this.logger.log(`Discovered ${tracks.length} track(s), queued ${queued} for processing`);

    await this.workers.waitUntilSettled();

    const scopes: LyricsScope[] = await store.getLyricsScopes();
    if (scopes.length > 0) {
      // A lyrics problem shouldn't cost the rest of the scan.
      await matchLibraryLyrics(this.fileAccess, store, scopes, tracks).catch((err: unknown) =>
        this.logger.warn(`Lyrics matching failed: ${String(err)}`),
      );
    }

    const jobs = await this.workers.queue.counts();
    const summary: ScanSummary = { startedAtMs, finishedAtMs: Date.now(), roots: libraryRoots.length, tracks: tracks.length, queued, jobs };
    this.last = summary;
    this.logger.log(
      `Scan finished in ${summary.finishedAtMs - startedAtMs}ms: ${jobs.done} done, ${jobs.retrying} waiting to retry, ${jobs.skipped} skipped` +
        (jobs.skipped > 0 ? ' (GET /api/v1/scan/jobs?state=SKIPPED for why)' : ''),
    );
    return summary;
  }
}

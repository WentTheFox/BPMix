import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ANALYSIS_ALGORITHM_VERSION,
  ensureTrackMetadata,
  isAnalysisFresh,
  isAudioFileName,
  matchLibraryLyrics,
  pruneOrphanedRootData,
  scanRoot,
  walkDirectory,
  type AnalysisResult,
  type FileRef,
  type LyricsScope,
  type TrackRecord,
} from '@bpmix/core';
import { DatabaseService } from '../db/database.module.js';
import { createNodeFileAccess, type NodeFileAccess } from '../node/nodeFileAccess.js';
import type { AnalyzeFile } from './analysisPool.js';
import { probeDurationSeconds } from './ffprobeDuration.js';
import { sharpCoverArtResizer } from './sharpCoverArtResizer.js';

export const ANALYZE_FILE = Symbol('ANALYZE_FILE');

export interface ScanSummary {
  startedAtMs: number;
  finishedAtMs: number;
  roots: number;
  tracks: number;
  metadataFailures: number;
  analysisFailures: number;
}

export interface ScanStatus {
  running: boolean;
  last: ScanSummary | null;
}

const METADATA_CONCURRENCY = 4;

function toFileRef(track: TrackRecord): FileRef {
  return {
    id: track.fileId,
    name: track.relativePath.split('/').pop() ?? track.relativePath,
    relativePath: track.relativePath,
    sizeBytes: track.sizeBytes,
    lastModifiedMs: track.lastModifiedMs,
  };
}

/** Runs `task` over `items` with at most `limit` in flight; failures are counted, not thrown. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<number> {
  let next = 0;
  let failures = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch (err) {
        failures++;
        onError(item, err);
      }
    }
  });
  await Promise.all(workers);
  return failures;
}

/**
 * Server-side library scan: walks each root, reads tags/cover art, matches
 * lyrics and measures loudness - all by running @bpmix/core's own scan code
 * against the Node FileAccess and the Postgres LibraryStore, so clients never
 * have to. Full scans only for now; a file watcher is a later addition.
 */
@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);
  private readonly fileAccess: NodeFileAccess;
  private current: Promise<ScanSummary> | null = null;
  private last: ScanSummary | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    @Inject(ANALYZE_FILE) private readonly analyzeFile: AnalyzeFile,
  ) {
    const lyricsRoots = new Set(
      (config.get<string>('BPMIX_LYRICS_ROOTS') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    );
    this.fileAccess = createNodeFileAccess(config.get<string>('BPMIX_LIBRARY_ROOT') ?? '/music', lyricsRoots);
  }

  onApplicationBootstrap(): void {
    if (this.config.get<string>('BPMIX_SCAN_ON_START') === 'false') return;
    void this.scanAll().catch((err: unknown) => this.logger.error(`Startup scan failed: ${String(err)}`));
  }

  /** Safety net for changes no one triggered a scan for (e.g. a network mount without change events). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  scheduledScan(): void {
    void this.scanAll().catch((err: unknown) => this.logger.error(`Scheduled scan failed: ${String(err)}`));
  }

  status(): ScanStatus {
    return { running: this.current !== null, last: this.last };
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

    for (const root of libraryRoots) {
      await scanRoot(this.fileAccess, store, root.id);
      await this.syncAudioFiles(root.id);
    }
    await pruneOrphanedRootData(store, roots.map((r) => r.id));
    await this.sweepOrphans();

    const tracks = (await store.listAllTracks()).filter((t) => !t.missing);

    const metadataFailures = await mapLimit(tracks, METADATA_CONCURRENCY, async (track) => {
      const ref = toFileRef(track);
      const metadata = await ensureTrackMetadata(store, this.fileAccess, ref, sharpCoverArtResizer);
      // Core reads the duration from the file header; formats it can't (Ogg/Opus, MP4 with a trailing moov, ...) come back null.
      if (metadata.durationSeconds === null) {
        const durationSeconds = await probeDurationSeconds(await this.fileAccess.absolutePathOf(ref));
        if (durationSeconds !== null) await store.putMetadata({ ...metadata, durationSeconds });
      }
    }, (track, err) => this.logger.warn(`Metadata failed for ${track.fileId}: ${String(err)}`));

    const scopes: LyricsScope[] = await store.getLyricsScopes();
    if (scopes.length > 0) {
      await matchLibraryLyrics(this.fileAccess, store, scopes, tracks);
    }

    // Analysis already spreads across worker threads inside analyzeFile; keep the feed to it modest.
    const analysisFailures = await mapLimit(tracks, 2, async (track) => {
      const ref = toFileRef(track);
      const existing = await store.getAnalysis(track.fileId);
      if (isAnalysisFresh(existing, ref)) return;
      const { normalizationGain } = await this.analyzeFile(await this.fileAccess.absolutePathOf(ref));
      const result: AnalysisResult = {
        fileId: track.fileId,
        normalizationGain,
        analyzedAtMs: Date.now(),
        sizeBytes: track.sizeBytes,
        lastModifiedMs: track.lastModifiedMs,
        algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
      };
      await store.putAnalysis(result);
    }, (track, err) => this.logger.warn(`Analysis failed for ${track.fileId}: ${String(err)}`));

    const summary: ScanSummary = {
      startedAtMs,
      finishedAtMs: Date.now(),
      roots: libraryRoots.length,
      tracks: tracks.length,
      metadataFailures,
      analysisFailures,
    };
    this.last = summary;
    this.logger.log(`Scan finished in ${summary.finishedAtMs - startedAtMs}ms: ${JSON.stringify(summary)}`);
    return summary;
  }
}

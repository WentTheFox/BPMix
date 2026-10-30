import { Inject, Injectable } from '@nestjs/common';
import {
  ANALYSIS_ALGORITHM_VERSION,
  ensureTrackMetadata,
  isAnalysisFresh,
  METADATA_PARSER_VERSION,
  type AnalysisResult,
  type FileRef,
  type TrackRecord,
} from '@bpmix/core';
import { DatabaseService } from '../db/database.module.js';
import { FILE_ACCESS, type NodeFileAccess } from '../node/node.module.js';
import type { AnalyzeFile } from './analysisPool.js';
import { probeDurationSeconds } from './ffprobeDuration.js';
import { sharpCoverArtResizer } from './sharpCoverArtResizer.js';
import { ANALYZE_FILE } from './tokens.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function toFileRef(track: TrackRecord): FileRef {
  return {
    id: track.fileId,
    name: track.relativePath.split('/').pop() ?? track.relativePath,
    relativePath: track.relativePath,
    sizeBytes: track.sizeBytes,
    lastModifiedMs: track.lastModifiedMs,
  };
}

/** Changes whenever the file or the code that interprets it changes - what makes a finished or skipped job eligible to run again. */
export function trackFingerprint(track: Pick<TrackRecord, 'sizeBytes' | 'lastModifiedMs'>): string {
  return `${track.sizeBytes}:${track.lastModifiedMs}:${METADATA_PARSER_VERSION}:${ANALYSIS_ALGORITHM_VERSION}`;
}

/**
 * The two per-track stages of a scan job. Each is idempotent (it checks the
 * stored result's freshness first), so a retry or a lease takeover is safe.
 * They throw on failure; the worker decides about retries.
 */
@Injectable()
export class TrackProcessor {
  constructor(
    private readonly db: DatabaseService,
    @Inject(FILE_ACCESS) private readonly fileAccess: NodeFileAccess,
    @Inject(ANALYZE_FILE) private readonly analyzeFile: AnalyzeFile,
  ) {}

  /** Tags, cover art, duration and content hash. */
  async readMetadata(track: TrackRecord): Promise<void> {
    const store = this.db.libraryStore;
    const ref = toFileRef(track);
    const metadata = await ensureTrackMetadata(store, this.fileAccess, ref, sharpCoverArtResizer);
    const patch: { durationSeconds?: number; contentHash?: string } = {};
    // Core reads the duration from the file header; formats it can't (Ogg/Opus, MP4 with a trailing moov, ...) come back null.
    if (metadata.durationSeconds === null) {
      const durationSeconds = await probeDurationSeconds(await this.fileAccess.absolutePathOf(ref));
      if (durationSeconds !== null) patch.durationSeconds = durationSeconds;
    }
    // Core's own hash is a cheap 32-bit FNV; clients verifying a download need a real digest.
    if (!SHA256_HEX.test(metadata.contentHash ?? '')) {
      const contentHash = await this.fileAccess.getContentHash?.(ref);
      if (contentHash) patch.contentHash = contentHash;
    }
    if (Object.keys(patch).length > 0) await store.putMetadata({ ...metadata, ...patch });
  }

  /** Decodes the track and stores its loudness gain. */
  async analyze(track: TrackRecord): Promise<void> {
    const store = this.db.libraryStore;
    const ref = toFileRef(track);
    if (isAnalysisFresh(await store.getAnalysis(track.fileId), ref)) return;
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
  }
}

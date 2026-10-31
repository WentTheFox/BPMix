import { open } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import {
  ANALYSIS_ALGORITHM_VERSION,
  ensureTrackMetadata,
  id3v2TagLength,
  isAnalysisFresh,
  METADATA_PARSER_VERSION,
  readEmbeddedLyrics,
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

/** Bumped when what is read into `embedded_lyrics` changes, so already-scanned tracks get read again. */
const EMBEDDED_LYRICS_VERSION = 1;

/** A tag bigger than this (mostly cover art) isn't read for lyrics. */
const MAX_TAG_BYTES = 32 * 1024 * 1024;

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
  return `${track.sizeBytes}:${track.lastModifiedMs}:${METADATA_PARSER_VERSION}:${ANALYSIS_ALGORITHM_VERSION}:${EMBEDDED_LYRICS_VERSION}`;
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
    await this.readLyricsFromTag(track);
  }

  /** The lyrics in an MP3's ID3 tag (USLT), kept so a track with no linked .lrc file still has some. Only the tag is read, not the audio. */
  private async readLyricsFromTag(track: TrackRecord): Promise<void> {
    if (!/\.mp3$/i.test(track.relativePath)) return;
    const prisma = this.db.prisma;
    const existing = await prisma.embeddedLyrics.findUnique({ where: { fileId: track.fileId } });
    if (existing && Number(existing.sizeBytes) === track.sizeBytes && existing.lastModifiedMs === track.lastModifiedMs) return;
    const handle = await open(await this.fileAccess.absolutePathOf(toFileRef(track)), 'r');
    let text: string | null = null;
    try {
      const header = Buffer.alloc(10);
      const { bytesRead } = await handle.read(header, 0, 10, 0);
      const length = id3v2TagLength(header.subarray(0, bytesRead));
      if (length > 0 && length <= MAX_TAG_BYTES) {
        const tag = Buffer.alloc(length);
        const read = await handle.read(tag, 0, length, 0);
        text = readEmbeddedLyrics(tag.subarray(0, read.bytesRead));
      }
    } finally {
      await handle.close();
    }
    const data = { text, sizeBytes: BigInt(track.sizeBytes), lastModifiedMs: track.lastModifiedMs };
    await prisma.embeddedLyrics.upsert({ where: { fileId: track.fileId }, create: { fileId: track.fileId, ...data }, update: data });
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

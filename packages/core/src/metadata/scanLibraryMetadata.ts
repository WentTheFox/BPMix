import type { FileAccess, FileRef } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import { yieldToEventLoop } from '../analysis/yieldToEventLoop';
import type { CoverArtResizer } from './coverArtResizer';
import { ensureTrackMetadata, isMetadataFresh } from './ensureMetadata';

export interface ScanMetadataProgress {
  track: TrackRecord;
  index: number;
  total: number;
  skipped: boolean;
  error?: unknown;
}

export interface ScanLibraryMetadataOptions {
  /** Called after each track's metadata read attempt (skipped, succeeded, or failed) - lets callers refresh the library screen as titles come in. */
  onProgress?: (info: ScanMetadataProgress) => void;
  /** Downscales oversized embedded cover art before storing it - see ensureTrackMetadata. */
  resizer?: CoverArtResizer;
  /**
   * Called before each track is scanned - return fileIds (e.g. the
   * currently-playing and up-next tracks) that should jump the queue if
   * they haven't been scanned yet this pass. Evaluated fresh before every
   * step (not just once up front), so a track that becomes "current"
   * partway through an already-running scan still gets bumped up instead
   * of waiting for the scan to reach it in its original list position -
   * important on a large library, where a stale-parser-version rescan can
   * take a while to reach whatever the user actually has on screen.
   */
  getPriorityFileIds?: () => string[];
}

function trackToFileRef(track: TrackRecord): FileRef {
  return {
    id: track.fileId,
    name: track.relativePath.split('/').pop() ?? track.relativePath,
    relativePath: track.relativePath,
    sizeBytes: track.sizeBytes,
    lastModifiedMs: track.lastModifiedMs,
  };
}

/**
 * Reads ID3 tags for every track in the given list that's new or whose
 * stored metadata is stale, persisting results as it goes. Unlike
 * analyzeLibrary() (BPM/loudness, deliberately not auto-run because
 * decoding a whole library starves the UI thread), reading tag bytes is
 * cheap - this is meant to be fired off in the background right after a
 * scan, so the library screen fills in real titles/artists in place of
 * filenames as it completes (see useTrackMetadata's retry-poll on the UI
 * side). A bad/unreadable file is reported via onProgress rather than
 * aborting the run, same as analyzeLibrary.
 */
export async function scanLibraryMetadata(
  fileAccess: FileAccess,
  store: LibraryStore,
  tracks: TrackRecord[],
  options: ScanLibraryMetadataOptions = {},
): Promise<void> {
  const remaining = [...tracks];
  const total = remaining.length;
  for (let index = 0; index < total; index++) {
    // Default to the next track in original order - only reach for a
    // priority one if one's actually still pending, so this stays a no-op
    // (and no extra scan cost) for callers that don't pass the option.
    let nextIndex = 0;
    const priorityFileIds = options.getPriorityFileIds?.();
    if (priorityFileIds && priorityFileIds.length > 0) {
      const prioritizedIndex = remaining.findIndex((t) => priorityFileIds.includes(t.fileId));
      if (prioritizedIndex !== -1) nextIndex = prioritizedIndex;
    }
    const track = remaining.splice(nextIndex, 1)[0]!;

    const existing = await store.getMetadata(track.fileId);
    if (isMetadataFresh(existing, track)) {
      options.onProgress?.({ track, index, total, skipped: true });
      await yieldToEventLoop();
      continue;
    }

    try {
      await ensureTrackMetadata(store, fileAccess, trackToFileRef(track), options.resizer);
      options.onProgress?.({ track, index, total, skipped: false });
    } catch (error) {
      options.onProgress?.({ track, index, total, skipped: false, error });
    }
    await yieldToEventLoop();
  }
}

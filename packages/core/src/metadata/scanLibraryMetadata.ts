import type { FileAccess, FileRef } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import type { CoverArtResizer } from './coverArtResizer';
import { ensureTrackMetadata, isMetadataFresh } from './ensureMetadata';
import { requestIdle } from './idleCallback';

/**
 * Upper bound on how long a single scanLibraryMetadata() run is allowed to
 * go without the JS thread actually being idle before it's given a slice
 * anyway - requestIdleCallback's own `timeout` option, passed straight
 * through by requestIdle(). Without this, a screen kept continuously busy
 * (animations, frequent re-renders) could starve the scan indefinitely;
 * this caps that to a bounded worst-case delay per chunk instead.
 */
const IDLE_CALLBACK_TIMEOUT_MS = 2000;

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
 *
 * Work is chunked against real idle time (requestIdle, backed by
 * requestIdleCallback where available) rather than a fixed per-track
 * setTimeout(0): as many tracks as fit in one idle deadline are processed
 * back-to-back before yielding, so a long idle window (nothing else going
 * on) drains the scan faster, while a busy one (animations, active
 * scrolling) still only takes a track at a time between real gaps - this
 * replaced the previous InteractionManager.runAfterInteractions-triggered,
 * setTimeout(0)-between-every-track design (InteractionManager is
 * deprecated on this RN version).
 */
export function scanLibraryMetadata(
  fileAccess: FileAccess,
  store: LibraryStore,
  tracks: TrackRecord[],
  options: ScanLibraryMetadataOptions = {},
): Promise<void> {
  const remaining = [...tracks];
  const total = remaining.length;
  let index = 0;

  const processOne = async (): Promise<void> => {
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
    const currentIndex = index++;

    const existing = await store.getMetadata(track.fileId);
    if (isMetadataFresh(existing, track)) {
      options.onProgress?.({ track, index: currentIndex, total, skipped: true });
      return;
    }

    try {
      await ensureTrackMetadata(store, fileAccess, trackToFileRef(track), options.resizer);
      options.onProgress?.({ track, index: currentIndex, total, skipped: false });
    } catch (error) {
      options.onProgress?.({ track, index: currentIndex, total, skipped: false, error });
    }
  };

  if (total === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const runChunk = (deadline: { didTimeout: boolean; timeRemaining(): number }) => {
      void (async () => {
        // At least one track always runs per chunk (even with zero time
        // left) - otherwise a deadline that reports 0 remaining right away
        // would reschedule forever without ever making progress.
        do {
          await processOne();
        } while (index < total && (deadline.didTimeout || deadline.timeRemaining() > 0));

        if (index < total) {
          requestIdle(runChunk, IDLE_CALLBACK_TIMEOUT_MS);
        } else {
          resolve();
        }
      })();
    };
    requestIdle(runChunk, IDLE_CALLBACK_TIMEOUT_MS);
  });
}

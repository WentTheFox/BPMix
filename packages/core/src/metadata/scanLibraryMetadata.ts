import type { FileAccess, FileRef } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import { yieldToEventLoop } from '../analysis/yieldToEventLoop';
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
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index]!;
    const existing = await store.getMetadata(track.fileId);
    if (isMetadataFresh(existing, track)) {
      options.onProgress?.({ track, index, total: tracks.length, skipped: true });
      await yieldToEventLoop();
      continue;
    }

    try {
      await ensureTrackMetadata(store, fileAccess, trackToFileRef(track));
      options.onProgress?.({ track, index, total: tracks.length, skipped: false });
    } catch (error) {
      options.onProgress?.({ track, index, total: tracks.length, skipped: false, error });
    }
    await yieldToEventLoop();
  }
}

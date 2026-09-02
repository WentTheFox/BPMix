import type { AudioEngine } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import { ensureTrackAnalyzed, isAnalysisFresh } from './ensureAnalyzed';
import { yieldToEventLoop } from './yieldToEventLoop';

export interface AnalyzeProgress {
  track: TrackRecord;
  index: number;
  total: number;
  skipped: boolean;
  error?: unknown;
}

export interface AnalyzeLibraryOptions {
  /** Called after each track's analysis attempt (skipped, succeeded, or failed) - lets callers show progress in a debug view. */
  onProgress?: (info: AnalyzeProgress) => void;
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
 * Eagerly analyzes every track in the given list that's new or whose
 * stored analysis is stale (built on the same ensureTrackAnalyzed()
 * primitive the just-in-time path uses when a track is decoded for
 * playback/preload). Not auto-triggered by either app - decoding and
 * analyzing an entire library up front turned out to starve the UI thread
 * for as long as it ran, for tracks the user might never even play. Kept
 * as an available utility (e.g. for an explicit "analyze everything now"
 * action) since the per-track logic and skip/retry semantics are still
 * useful on their own.
 *
 * Analysis failures (corrupt/unreadable file, decode error) are caught per
 * track and reported via onProgress rather than aborting the whole run -
 * one bad file shouldn't block analyzing the rest of the library.
 */
export async function analyzeLibrary(
  audioEngine: AudioEngine,
  store: LibraryStore,
  tracks: TrackRecord[],
  options: AnalyzeLibraryOptions = {},
): Promise<void> {
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index]!;
    const existing = await store.getAnalysis(track.fileId);
    if (isAnalysisFresh(existing, track)) {
      options.onProgress?.({ track, index, total: tracks.length, skipped: true });
      await yieldToEventLoop();
      continue;
    }

    try {
      const ref = trackToFileRef(track);
      const decoded = await audioEngine.decodeFile(ref);
      await ensureTrackAnalyzed(store, ref, decoded, audioEngine);
      options.onProgress?.({ track, index, total: tracks.length, skipped: false });
    } catch (error) {
      options.onProgress?.({ track, index, total: tracks.length, skipped: false, error });
    }
    await yieldToEventLoop();
  }
}

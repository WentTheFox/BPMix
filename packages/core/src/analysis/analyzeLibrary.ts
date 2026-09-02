import type { AudioEngine } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import { analyzeTrack } from './analyzeTrack';

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
 * Analyzes every track that's new or whose stored analysis is stale
 * (sizeBytes/lastModifiedMs changed since it was last analyzed) - a track
 * unchanged since its last analysis is skipped entirely, no decode
 * performed. One function serves all three trigger points from the plan
 * (initial folder add, every startup, manual rescan) - callers just pass
 * whichever TrackRecord[] is relevant for that trigger.
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
    if (existing && existing.sizeBytes === track.sizeBytes && existing.lastModifiedMs === track.lastModifiedMs) {
      options.onProgress?.({ track, index, total: tracks.length, skipped: true });
      continue;
    }

    try {
      const decoded = await audioEngine.decodeFile(trackToFileRef(track));
      const { startWindow, endWindow, normalizationGain } = analyzeTrack(decoded);
      await store.putAnalysis({
        fileId: track.fileId,
        startWindow,
        endWindow,
        normalizationGain,
        analyzedAtMs: Date.now(),
        sizeBytes: track.sizeBytes,
        lastModifiedMs: track.lastModifiedMs,
      });
      options.onProgress?.({ track, index, total: tracks.length, skipped: false });
    } catch (error) {
      options.onProgress?.({ track, index, total: tracks.length, skipped: false, error });
    }
  }
}

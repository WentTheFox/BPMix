import type { DecodedAudio } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { AnalysisResult, LibraryStore } from '../library-store/types';
import { analyzeTrack } from './analyzeTrack';

/**
 * Returns the track's cached analysis if it's still fresh (same
 * size/mtime as when it was analyzed), otherwise analyzes the given
 * already-decoded buffer and persists the result. The shared primitive
 * behind both analyzeLibrary()'s eager batch pass and the just-in-time
 * analysis triggered by playback/preload decoding a track for the first
 * time - callers that already have a DecodedAudio (they decoded it for
 * playback or preload anyway) get analysis at no extra decode cost.
 */
export async function ensureTrackAnalyzed(
  store: LibraryStore,
  ref: FileRef,
  decoded: DecodedAudio,
): Promise<AnalysisResult> {
  const existing = await store.getAnalysis(ref.id);
  if (existing && existing.sizeBytes === ref.sizeBytes && existing.lastModifiedMs === ref.lastModifiedMs) {
    return existing;
  }
  const { startWindow, endWindow, normalizationGain } = analyzeTrack(decoded);
  const result: AnalysisResult = {
    fileId: ref.id,
    startWindow,
    endWindow,
    normalizationGain,
    analyzedAtMs: Date.now(),
    sizeBytes: ref.sizeBytes,
    lastModifiedMs: ref.lastModifiedMs,
  };
  await store.putAnalysis(result);
  return result;
}

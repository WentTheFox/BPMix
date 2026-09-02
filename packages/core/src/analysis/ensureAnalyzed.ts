import type { AudioEngine, DecodedAudio } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { AnalysisResult, LibraryStore } from '../library-store/types';
import { ANALYSIS_ALGORITHM_VERSION, analyzeTrack } from './analyzeTrack';

/**
 * True if a stored AnalysisResult can still be trusted for the given file:
 * same size/mtime as when it was analyzed, AND produced by the current
 * ANALYSIS_ALGORITHM_VERSION - a version bump makes every existing result
 * stale even though the file itself hasn't changed, the same way a changed
 * size/mtime would. Exported so analyzeLibrary's own pre-check (skip vs.
 * decode+analyze) can't drift out of sync with ensureTrackAnalyzed's.
 */
export function isAnalysisFresh(
  existing: AnalysisResult | null,
  ref: Pick<FileRef, 'sizeBytes' | 'lastModifiedMs'>,
): existing is AnalysisResult {
  return (
    existing !== null &&
    existing.sizeBytes === ref.sizeBytes &&
    existing.lastModifiedMs === ref.lastModifiedMs &&
    existing.algorithmVersion === ANALYSIS_ALGORITHM_VERSION
  );
}

/**
 * Returns the track's cached analysis if it's still fresh (see
 * isAnalysisFresh), otherwise analyzes the given already-decoded buffer and
 * persists the result. The shared primitive behind both analyzeLibrary()'s
 * eager batch pass and the just-in-time analysis triggered by
 * playback/preload decoding a track for the first time - callers that
 * already have a DecodedAudio (they decoded it for playback or preload
 * anyway) get analysis at no extra decode cost.
 *
 * `engine`, when given and it implements AudioEngine.analyzeTrack, runs
 * analysis there instead of the shared JS analyzeTrack() - see that
 * optional method's doc comment for why (Windows UI-thread stutter).
 */
export async function ensureTrackAnalyzed(
  store: LibraryStore,
  ref: FileRef,
  decoded: DecodedAudio,
  engine?: AudioEngine,
): Promise<AnalysisResult> {
  const existing = await store.getAnalysis(ref.id);
  if (isAnalysisFresh(existing, ref)) {
    return existing;
  }
  const { startWindow, endWindow, normalizationGain } = await (engine?.analyzeTrack?.(decoded) ?? analyzeTrack(decoded));
  const result: AnalysisResult = {
    fileId: ref.id,
    startWindow,
    endWindow,
    normalizationGain,
    analyzedAtMs: Date.now(),
    sizeBytes: ref.sizeBytes,
    lastModifiedMs: ref.lastModifiedMs,
    algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
  };
  await store.putAnalysis(result);
  return result;
}

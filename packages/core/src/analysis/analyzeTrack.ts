import type { DecodedAudio } from '../audio-engine/types';
import { computeNormalizationGain, measureLoudnessDb } from './loudness';
import { mixToMono } from './mono';
import { findContentBounds } from './silence';
import { yieldToEventLoop } from './yieldToEventLoop';

/**
 * Bump this whenever a change to analyzeTrack/loudness would produce
 * different results for a file that's already been analyzed -
 * ensureTrackAnalyzed (see isAnalysisFresh) treats a stored result whose
 * algorithmVersion doesn't match this the same as a changed file
 * size/mtime: stale, recompute. Without this, an algorithm fix silently
 * never applies to already-analyzed files until someone manually clears
 * the analysis table.
 */
export const ANALYSIS_ALGORITHM_VERSION = 2;

const ANALYSIS_WINDOW_SECONDS = 30;

export interface TrackAnalysis {
  normalizationGain: number;
}

/**
 * Loudness-only analysis over a decoded track: trim leading/trailing
 * silence, then measure loudness over the pooled first/last
 * ANALYSIS_WINDOW_SECONDS of the remaining content (deduping the overlap on
 * a short track rather than double-counting it) to compute a normalization
 * gain.
 *
 * This used to also run a whole-track BPM/beat-anchor search over each end
 * (see git history for bestBpmEstimateForSuffixes/Prefixes) to drive the
 * crossfade engine's beat-snapped tempo ramp - per CLAUDE.md's crossfade
 * rework, BPM matching is now a live "past few seconds" concern instead of
 * a precomputed one, and rate/speed manipulation is dropped for this round
 * entirely, so that search (and the AnalysisResult fields it fed) is gone.
 * Only loudness remains here, since there's no live-calibrated replacement
 * for normalization gain yet.
 *
 * Async, and yields between every major step - not just for its own sake:
 * this is called synchronously from the just-in-time analysis path the
 * instant a track starts playing (ensureTrackAnalyzed, triggered from
 * decodeAndNotify), not just analyzeLibrary's already-yielding batch pass,
 * so running as one uninterrupted block would stall the very first render
 * after pressing play. mixToMono/findContentBounds chunk and yield
 * internally too (a multi-minute track's single-pass scan is still real
 * synchronous work on its own), so the explicit yields here are on top of
 * that, at the boundaries between the major phases.
 */
export async function analyzeTrack(audio: DecodedAudio): Promise<TrackAnalysis> {
  await yieldToEventLoop();
  const mono = await mixToMono(audio);
  await yieldToEventLoop();

  const { startSample, endSample } = await findContentBounds(audio, mono);
  await yieldToEventLoop();

  const windowSamples = Math.round(ANALYSIS_WINDOW_SECONDS * audio.sampleRate);
  const firstWindowEnd = Math.min(startSample + windowSamples, endSample);
  const lastWindowStart = Math.max(endSample - windowSamples, startSample);

  // Loudness is a whole-track perceptual property, not a per-side one, so
  // it's measured over both windows pooled together (deduping the overlap
  // on a short track rather than double-counting it).
  let pooledForLoudness: Float32Array;
  if (lastWindowStart <= firstWindowEnd) {
    pooledForLoudness = mono.slice(startSample, endSample);
  } else {
    const firstWindow = mono.slice(startSample, firstWindowEnd);
    const lastWindow = mono.slice(lastWindowStart, endSample);
    pooledForLoudness = new Float32Array(firstWindow.length + lastWindow.length);
    pooledForLoudness.set(firstWindow, 0);
    pooledForLoudness.set(lastWindow, firstWindow.length);
  }
  const normalizationGain = computeNormalizationGain(measureLoudnessDb(pooledForLoudness));

  return { normalizationGain };
}

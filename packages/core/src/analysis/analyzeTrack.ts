import type { DecodedAudio } from '../audio-engine/types';
import type { WindowAnalysis } from '../library-store/types';
import { estimateBpm, type BpmEstimate } from './bpm';
import { computeNormalizationGain, measureLoudnessDb } from './loudness';
import { mixToMono } from './mono';
import { findContentBounds } from './silence';
import { yieldToEventLoop } from './yieldToEventLoop';

/**
 * Bump this whenever a change to analyzeTrack/estimateBpm/loudness would
 * produce different results for a file that's already been analyzed -
 * ensureTrackAnalyzed (see isAnalysisFresh) treats a stored result whose
 * algorithmVersion doesn't match this the same as a changed file
 * size/mtime: stale, recompute. Without this, an algorithm fix silently
 * never applies to already-analyzed files until someone manually clears
 * the analysis table.
 */
export const ANALYSIS_ALGORITHM_VERSION = 1;

const ANALYSIS_WINDOW_SECONDS = 30;
/**
 * Trimmed-window candidates tried on top of the full analysis window, when
 * searching for the earliest confident beat within it (see
 * bestBpmEstimateForSuffixes/Prefixes) - longest (the full window) first,
 * so an exact confidence tie prefers the fuller, more representative
 * estimate over a shorter, more overfit-prone one.
 */
const CANDIDATE_WINDOW_SECONDS = [ANALYSIS_WINDOW_SECONDS, 20, 15, 10];

/**
 * If nothing within the first ANALYSIS_WINDOW_SECONDS clears this, keep
 * searching further into the track (see EXTENDED_SEARCH_*) instead of
 * settling for the best of a region that may contain no real beat at all -
 * a non-rhythmic intro/outro longer than what CANDIDATE_WINDOW_SECONDS can
 * trim around (over ~20s of it) would otherwise leave every in-window
 * candidate low-confidence-but-still-numerically-defined, which can still
 * clear the transition-plan's own usability floor (MIN_BPM_CONFIDENCE in
 * computeTransitionPlan.ts) while being a flat-out misdetection. This bar
 * is deliberately much higher - "clearly, actually periodic," not just
 * "better than the other candidates."
 */
const MIN_SEARCH_CONFIDENCE = 0.3;
/** How far past ANALYSIS_WINDOW_SECONDS to keep sliding a search window, for a track whose beat genuinely doesn't establish until deep into a long intro/outro. */
const EXTENDED_SEARCH_MAX_SECONDS = 90;
const EXTENDED_SEARCH_STEP_SECONDS = 10;
const EXTENDED_SEARCH_WINDOW_SECONDS = 15;

export interface TrackAnalysis {
  startWindow: WindowAnalysis;
  endWindow: WindowAnalysis;
  normalizationGain: number;
}

interface WindowEstimate {
  estimate: BpmEstimate;
  /** Sample offset (within the full mono buffer) that estimate.firstBeatOffsetSeconds is relative to. */
  anchorSampleOffset: number;
}

/**
 * Tries the full [windowStartSample, windowEndSample) window plus several
 * candidates trimmed from the *front* (same end, later starts), keeping
 * whichever gives the highest confidence - for a window whose beat doesn't
 * really kick in until partway through (a sparse/non-percussive intro; the
 * comb filter has nothing periodic to lock onto there), averaging the
 * whole window dilutes both the detected tempo and its own confidence
 * score, even though a clearly confident beat exists later within the same
 * window. Used for the *start* window, where a weak intro sits at the front.
 *
 * If none of those candidates are genuinely confident (the whole
 * ANALYSIS_WINDOW_SECONDS turns out to be non-rhythmic - a longer intro
 * than CANDIDATE_WINDOW_SECONDS can trim around), keeps sliding a fixed-
 * length window forward past it, up to EXTENDED_SEARCH_MAX_SECONDS into the
 * track, stopping at the first one that's actually confident - "where a
 * consistent beat starts," not just the best of a region that may not have
 * one at all.
 *
 * Yields to the event loop (see yieldToEventLoop) between every candidate:
 * each estimateBpm() call is a real, non-trivial chunk of synchronous work,
 * and this is called from the just-in-time analysis path at playback start
 * (ensureTrackAnalyzed), not just analyzeLibrary's already-yielding batch
 * pass - up to ~13 candidates back to back with no yield at all (4 base +
 * up to 9 extended) was long enough to visibly stall the UI right as
 * playback began.
 */
async function bestBpmEstimateForSuffixes(
  mono: Float32Array,
  sampleRate: number,
  windowStartSample: number,
  windowEndSample: number,
  contentEndSample: number,
): Promise<WindowEstimate> {
  let best: WindowEstimate | null = null;
  for (const seconds of CANDIDATE_WINDOW_SECONDS) {
    const candidateStart = Math.max(windowStartSample, windowEndSample - Math.round(seconds * sampleRate));
    const estimate = estimateBpm(mono.slice(candidateStart, windowEndSample), sampleRate);
    if (!best || estimate.confidence > best.estimate.confidence) {
      best = { estimate, anchorSampleOffset: candidateStart };
    }
    await yieldToEventLoop();
  }
  // CANDIDATE_WINDOW_SECONDS is non-empty, so best is always set by here.
  if (best!.estimate.confidence < MIN_SEARCH_CONFIDENCE) {
    const windowSamples = Math.round(EXTENDED_SEARCH_WINDOW_SECONDS * sampleRate);
    const stepSamples = Math.round(EXTENDED_SEARCH_STEP_SECONDS * sampleRate);
    const searchLimit = Math.min(contentEndSample, windowEndSample + Math.round(EXTENDED_SEARCH_MAX_SECONDS * sampleRate));
    for (
      let candidateStart = windowEndSample;
      candidateStart + windowSamples <= searchLimit;
      candidateStart += stepSamples
    ) {
      const estimate = estimateBpm(mono.slice(candidateStart, candidateStart + windowSamples), sampleRate);
      if (estimate.confidence > best!.estimate.confidence) {
        best = { estimate, anchorSampleOffset: candidateStart };
      }
      if (best!.estimate.confidence >= MIN_SEARCH_CONFIDENCE) break;
      await yieldToEventLoop();
    }
  }
  return best as WindowEstimate;
}

/**
 * Same idea as bestBpmEstimateForSuffixes, but trims from the *back* (same
 * start, earlier ends), and the extended search slides backward from
 * windowStartSample instead of forward - used for the *end* window, where a
 * weak outro/breakdown (audible but not clearly rhythmic - already-trimmed
 * silence doesn't cover this) sits at the back instead.
 */
async function bestBpmEstimateForPrefixes(
  mono: Float32Array,
  sampleRate: number,
  windowStartSample: number,
  windowEndSample: number,
  contentStartSample: number,
): Promise<WindowEstimate> {
  let best: WindowEstimate | null = null;
  for (const seconds of CANDIDATE_WINDOW_SECONDS) {
    const candidateEnd = Math.min(windowEndSample, windowStartSample + Math.round(seconds * sampleRate));
    const estimate = estimateBpm(mono.slice(windowStartSample, candidateEnd), sampleRate);
    if (!best || estimate.confidence > best.estimate.confidence) {
      best = { estimate, anchorSampleOffset: windowStartSample };
    }
    await yieldToEventLoop();
  }
  // CANDIDATE_WINDOW_SECONDS is non-empty, so best is always set by here.
  if (best!.estimate.confidence < MIN_SEARCH_CONFIDENCE) {
    const windowSamples = Math.round(EXTENDED_SEARCH_WINDOW_SECONDS * sampleRate);
    const stepSamples = Math.round(EXTENDED_SEARCH_STEP_SECONDS * sampleRate);
    const searchLimit = Math.max(contentStartSample, windowStartSample - Math.round(EXTENDED_SEARCH_MAX_SECONDS * sampleRate));
    for (
      let candidateEnd = windowStartSample;
      candidateEnd - windowSamples >= searchLimit;
      candidateEnd -= stepSamples
    ) {
      const candidateStart = candidateEnd - windowSamples;
      const estimate = estimateBpm(mono.slice(candidateStart, candidateEnd), sampleRate);
      if (estimate.confidence > best!.estimate.confidence) {
        best = { estimate, anchorSampleOffset: candidateStart };
      }
      if (best!.estimate.confidence >= MIN_SEARCH_CONFIDENCE) break;
      await yieldToEventLoop();
    }
  }
  return best as WindowEstimate;
}

/**
 * BPM + beat-phase + loudness analysis over a decoded track, per the plan:
 * trim leading/trailing silence first (see
 * [[silence-trimming-for-transition-window]]), then analyze the first and
 * last ANALYSIS_WINDOW_SECONDS of the remaining content *separately* - not
 * pooled into one signal - since a transition needs to know the tempo and
 * beat position at each end of the track independently (the "incoming"
 * side for the next track's start, the "outgoing" side for this track's
 * end), not just an averaged tempo for the whole track.
 *
 * Within each window, searches a few trimmed sub-windows for the highest-
 * confidence estimate (see bestBpmEstimateForSuffixes/Prefixes) rather than
 * always trusting the full window - silence-trimming alone doesn't help
 * when the weak part is audible content that just isn't rhythmically
 * distinct (a vocal-only intro, a breakdown), which is common enough to
 * matter for real tracks.
 *
 * If the trimmed content is shorter than two full windows, the first/last
 * windows overlap - both still get analyzed independently (a short track's
 * opening and closing tempo estimates naturally end up close to each
 * other, which is correct, not a bug).
 *
 * Async, and yields before doing any work: called synchronously from the
 * just-in-time analysis path the instant a track starts playing
 * (ensureTrackAnalyzed, triggered from decodeAndNotify), this used to run
 * as one uninterrupted block on the same JS thread React Native uses for
 * UI - stalling the very first render after pressing play, worse the
 * longer the search runs (see bestBpmEstimateForSuffixes/Prefixes).
 */
export async function analyzeTrack(audio: DecodedAudio): Promise<TrackAnalysis> {
  await yieldToEventLoop();
  const mono = mixToMono(audio);
  const { startSample, endSample } = findContentBounds(audio);
  const windowSamples = Math.round(ANALYSIS_WINDOW_SECONDS * audio.sampleRate);

  const firstWindowEnd = Math.min(startSample + windowSamples, endSample);
  const lastWindowStart = Math.max(endSample - windowSamples, startSample);

  const firstResult = await bestBpmEstimateForSuffixes(mono, audio.sampleRate, startSample, firstWindowEnd, endSample);
  const lastResult = await bestBpmEstimateForPrefixes(mono, audio.sampleRate, lastWindowStart, endSample, startSample);

  const startWindow: WindowAnalysis = {
    bpm: firstResult.estimate.bpm,
    bpmConfidence: firstResult.estimate.confidence,
    beatAnchorSeconds: firstResult.anchorSampleOffset / audio.sampleRate + firstResult.estimate.firstBeatOffsetSeconds,
  };
  const endWindow: WindowAnalysis = {
    bpm: lastResult.estimate.bpm,
    bpmConfidence: lastResult.estimate.confidence,
    beatAnchorSeconds: lastResult.anchorSampleOffset / audio.sampleRate + lastResult.estimate.firstBeatOffsetSeconds,
  };

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

  return { startWindow, endWindow, normalizationGain };
}

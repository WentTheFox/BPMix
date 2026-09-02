import type { DecodedAudio } from '../audio-engine/types';
import type { WindowAnalysis } from '../library-store/types';
import { estimateBpm, type BpmEstimate } from './bpm';
import { computeNormalizationGain, measureLoudnessDb } from './loudness';
import { mixToMono } from './mono';
import { findContentBounds } from './silence';

const ANALYSIS_WINDOW_SECONDS = 30;
/**
 * Trimmed-window candidates tried on top of the full analysis window, when
 * searching for the earliest confident beat within it (see
 * bestBpmEstimateForSuffixes/Prefixes) - longest (the full window) first,
 * so an exact confidence tie prefers the fuller, more representative
 * estimate over a shorter, more overfit-prone one.
 */
const CANDIDATE_WINDOW_SECONDS = [ANALYSIS_WINDOW_SECONDS, 20, 15, 10];

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
 */
function bestBpmEstimateForSuffixes(
  mono: Float32Array,
  sampleRate: number,
  windowStartSample: number,
  windowEndSample: number,
): WindowEstimate {
  let best: WindowEstimate | null = null;
  for (const seconds of CANDIDATE_WINDOW_SECONDS) {
    const candidateStart = Math.max(windowStartSample, windowEndSample - Math.round(seconds * sampleRate));
    const estimate = estimateBpm(mono.slice(candidateStart, windowEndSample), sampleRate);
    if (!best || estimate.confidence > best.estimate.confidence) {
      best = { estimate, anchorSampleOffset: candidateStart };
    }
  }
  return best as WindowEstimate;
}

/**
 * Same idea as bestBpmEstimateForSuffixes, but trims from the *back* (same
 * start, earlier ends) - used for the *end* window, where a weak outro/
 * breakdown (audible but not clearly rhythmic - already-trimmed silence
 * doesn't cover this) sits at the back instead.
 */
function bestBpmEstimateForPrefixes(
  mono: Float32Array,
  sampleRate: number,
  windowStartSample: number,
  windowEndSample: number,
): WindowEstimate {
  let best: WindowEstimate | null = null;
  for (const seconds of CANDIDATE_WINDOW_SECONDS) {
    const candidateEnd = Math.min(windowEndSample, windowStartSample + Math.round(seconds * sampleRate));
    const estimate = estimateBpm(mono.slice(windowStartSample, candidateEnd), sampleRate);
    if (!best || estimate.confidence > best.estimate.confidence) {
      best = { estimate, anchorSampleOffset: windowStartSample };
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
 */
export function analyzeTrack(audio: DecodedAudio): TrackAnalysis {
  const mono = mixToMono(audio);
  const { startSample, endSample } = findContentBounds(audio);
  const windowSamples = Math.round(ANALYSIS_WINDOW_SECONDS * audio.sampleRate);

  const firstWindowEnd = Math.min(startSample + windowSamples, endSample);
  const lastWindowStart = Math.max(endSample - windowSamples, startSample);

  const firstResult = bestBpmEstimateForSuffixes(mono, audio.sampleRate, startSample, firstWindowEnd);
  const lastResult = bestBpmEstimateForPrefixes(mono, audio.sampleRate, lastWindowStart, endSample);

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

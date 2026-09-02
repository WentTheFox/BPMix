import type { DecodedAudio } from '../audio-engine/types';
import type { WindowAnalysis } from '../library-store/types';
import { estimateBpm } from './bpm';
import { computeNormalizationGain, measureLoudnessDb } from './loudness';
import { mixToMono } from './mono';
import { findContentBounds } from './silence';

const ANALYSIS_WINDOW_SECONDS = 30;

export interface TrackAnalysis {
  startWindow: WindowAnalysis;
  endWindow: WindowAnalysis;
  normalizationGain: number;
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

  const firstWindow = mono.slice(startSample, firstWindowEnd);
  const lastWindow = mono.slice(lastWindowStart, endSample);

  const firstEstimate = estimateBpm(firstWindow, audio.sampleRate);
  const lastEstimate = estimateBpm(lastWindow, audio.sampleRate);

  const startWindow: WindowAnalysis = {
    bpm: firstEstimate.bpm,
    bpmConfidence: firstEstimate.confidence,
    beatAnchorSeconds: startSample / audio.sampleRate + firstEstimate.firstBeatOffsetSeconds,
  };
  const endWindow: WindowAnalysis = {
    bpm: lastEstimate.bpm,
    bpmConfidence: lastEstimate.confidence,
    beatAnchorSeconds: lastWindowStart / audio.sampleRate + lastEstimate.firstBeatOffsetSeconds,
  };

  // Loudness is a whole-track perceptual property, not a per-side one, so
  // it's measured over both windows pooled together (deduping the overlap
  // on a short track rather than double-counting it).
  let pooledForLoudness: Float32Array;
  if (lastWindowStart <= firstWindowEnd) {
    pooledForLoudness = mono.slice(startSample, endSample);
  } else {
    pooledForLoudness = new Float32Array(firstWindow.length + lastWindow.length);
    pooledForLoudness.set(firstWindow, 0);
    pooledForLoudness.set(lastWindow, firstWindow.length);
  }
  const normalizationGain = computeNormalizationGain(measureLoudnessDb(pooledForLoudness));

  return { startWindow, endWindow, normalizationGain };
}

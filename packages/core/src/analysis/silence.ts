import type { DecodedAudio } from '../audio-engine/types';
import { mixToMono } from './mono';

/** -45dBFS - well above noise floor, well below any audible content. */
const SILENCE_AMPLITUDE_THRESHOLD = 0.0056;
/** ~20ms per window - short enough to find the true edge of the content closely. */
const WINDOW_SECONDS = 0.02;

function windowRms(samples: Float32Array, startSample: number, windowLength: number): number {
  const end = Math.min(startSample + windowLength, samples.length);
  let sumSquares = 0;
  for (let i = startSample; i < end; i++) {
    const sample = samples[i] ?? 0;
    sumSquares += sample * sample;
  }
  const count = end - startSample;
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

/**
 * Finds the [startSample, endSample) range of actual audible content,
 * trimming leading/trailing near-silence (fade-ins/outs, dead air) - see
 * the [[silence-trimming-for-transition-window]] memory note for why this
 * matters: without it, a track whose literal last 30s is mostly silence
 * would give the BPM/loudness analysis (and later, Stage 7's crossfade
 * window) far less than 30s of real musical content to work with.
 *
 * Returns the full range unchanged if the track never exceeds the
 * silence threshold (nothing to trim, or the whole track is silent).
 */
export function findContentBounds(audio: DecodedAudio): { startSample: number; endSample: number } {
  const mono = mixToMono(audio);
  const totalSamples = mono.length;
  const windowLength = Math.max(1, Math.round(WINDOW_SECONDS * audio.sampleRate));

  let startSample = 0;
  for (let i = 0; i < totalSamples; i += windowLength) {
    if (windowRms(mono, i, windowLength) >= SILENCE_AMPLITUDE_THRESHOLD) {
      startSample = i;
      break;
    }
    startSample = totalSamples; // reached the end without finding content
  }

  let endSample = totalSamples;
  for (let i = totalSamples - windowLength; i + windowLength > startSample; i -= windowLength) {
    if (windowRms(mono, Math.max(i, 0), windowLength) >= SILENCE_AMPLITUDE_THRESHOLD) {
      endSample = Math.max(i, 0) + windowLength;
      break;
    }
    endSample = startSample; // reached the start without finding content
  }

  if (startSample >= endSample) {
    // Entirely silent (or degenerate) track - nothing usable to trim to,
    // fall back to the untrimmed range rather than an empty one.
    return { startSample: 0, endSample: totalSamples };
  }

  return { startSample, endSample: Math.min(endSample, totalSamples) };
}

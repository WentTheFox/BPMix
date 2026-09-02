import type { DecodedAudio } from '../audio-engine/types';
import { mixToMono } from './mono';
import { yieldToEventLoop } from './yieldToEventLoop';

/** -45dBFS - well above noise floor, well below any audible content. */
const SILENCE_AMPLITUDE_THRESHOLD = 0.0056;
/** ~20ms per window - short enough to find the true edge of the content closely. */
const WINDOW_SECONDS = 0.02;
/** Yield every this many windows scanned - only matters for a track that's silent (or near-silent) for a long stretch. */
const YIELD_EVERY_WINDOWS = 500;

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
 *
 * `mono` lets a caller that already downmixed the track (analyzeTrack
 * does) pass it straight in instead of this doing that full-track pass
 * again; omitted, it downmixes audio itself.
 */
export async function findContentBounds(
  audio: DecodedAudio,
  mono?: Float32Array,
): Promise<{ startSample: number; endSample: number }> {
  const monoSamples = mono ?? (await mixToMono(audio));
  const totalSamples = monoSamples.length;
  const windowLength = Math.max(1, Math.round(WINDOW_SECONDS * audio.sampleRate));

  let startSample = 0;
  let windowsScanned = 0;
  for (let i = 0; i < totalSamples; i += windowLength) {
    if (windowRms(monoSamples, i, windowLength) >= SILENCE_AMPLITUDE_THRESHOLD) {
      startSample = i;
      break;
    }
    startSample = totalSamples; // reached the end without finding content
    if (++windowsScanned % YIELD_EVERY_WINDOWS === 0) {
      await yieldToEventLoop();
    }
  }

  let endSample = totalSamples;
  for (let i = totalSamples - windowLength; i + windowLength > startSample; i -= windowLength) {
    if (windowRms(monoSamples, Math.max(i, 0), windowLength) >= SILENCE_AMPLITUDE_THRESHOLD) {
      endSample = Math.max(i, 0) + windowLength;
      break;
    }
    endSample = startSample; // reached the start without finding content
    if (++windowsScanned % YIELD_EVERY_WINDOWS === 0) {
      await yieldToEventLoop();
    }
  }

  if (startSample >= endSample) {
    // Entirely silent (or degenerate) track - nothing usable to trim to,
    // fall back to the untrimmed range rather than an empty one.
    return { startSample: 0, endSample: totalSamples };
  }

  return { startSample, endSample: Math.min(endSample, totalSamples) };
}

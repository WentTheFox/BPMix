import { describe, expect, it } from 'vitest';
import type { DecodedAudio } from '../audio-engine/types';
import { analyzeTrack } from './analyzeTrack';

const SAMPLE_RATE = 44100;

function tone(durationSeconds: number, amplitude: number): Float32Array {
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  }
  return out;
}

function silence(durationSeconds: number): Float32Array {
  return new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
}

function concat(...chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function makeDecodedAudio(samples: Float32Array): DecodedAudio {
  return {
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    channelData: [samples],
    durationSeconds: samples.length / SAMPLE_RATE,
  };
}

describe('analyzeTrack', () => {
  it('computes a normalization gain from the trimmed content, ignoring leading/trailing silence', async () => {
    const quiet = makeDecodedAudio(concat(silence(2), tone(10, 0.05), silence(2)));
    const loud = makeDecodedAudio(concat(silence(2), tone(10, 0.5), silence(2)));

    const quietResult = await analyzeTrack(quiet);
    const loudResult = await analyzeTrack(loud);

    // A quieter track needs to be boosted more (higher gain) to reach the
    // same reference loudness target than an already-louder one.
    expect(quietResult.normalizationGain).toBeGreaterThan(loudResult.normalizationGain);
    expect(quietResult.normalizationGain).toBeGreaterThan(0);
    expect(loudResult.normalizationGain).toBeGreaterThan(0);
  });

  it('handles a short track (content shorter than the pooled analysis window) without crashing', async () => {
    const audio = makeDecodedAudio(tone(2, 0.3));
    const { normalizationGain } = await analyzeTrack(audio);
    expect(normalizationGain).toBeGreaterThan(0);
  });
});

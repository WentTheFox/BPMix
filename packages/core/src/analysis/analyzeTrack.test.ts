import { describe, expect, it } from 'vitest';
import type { DecodedAudio } from '../audio-engine/types';
import { analyzeTrack } from './analyzeTrack';

const SAMPLE_RATE = 44100;

function clickTrain(durationSeconds: number, bpm: number, amplitude = 0.8): Float32Array {
  const periodSeconds = 60 / bpm;
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  for (let beatTime = 0; beatTime < durationSeconds; beatTime += periodSeconds) {
    const start = Math.round(beatTime * SAMPLE_RATE);
    const end = Math.min(length, start + Math.round(0.05 * SAMPLE_RATE));
    for (let i = start; i < end; i++) {
      out[i] = amplitude * Math.sin((2 * Math.PI * 1000 * (i - start)) / SAMPLE_RATE);
    }
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
  it('estimates start and end window bpm independently, and normalization gain', () => {
    // Leading/trailing silence, 120bpm content in between - a long-enough
    // track that the first/last 30s analysis windows don't overlap.
    const samples = concat(silence(2), clickTrain(70, 120), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startWindow, endWindow, normalizationGain } = analyzeTrack(audio);

    expect(startWindow.bpm).toBeGreaterThan(115);
    expect(startWindow.bpm).toBeLessThan(125);
    expect(endWindow.bpm).toBeGreaterThan(115);
    expect(endWindow.bpm).toBeLessThan(125);
    expect(normalizationGain).toBeGreaterThan(0);
  });

  it('anchors start/end beat positions in absolute track time, accounting for leading silence', () => {
    const leadingSilenceSeconds = 3;
    const samples = concat(silence(leadingSilenceSeconds), clickTrain(70, 120), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startWindow } = analyzeTrack(audio);

    // The beat anchor must fall after the leading silence, in the region
    // where content actually starts - not at some point inside the silence.
    expect(startWindow.beatAnchorSeconds).toBeGreaterThanOrEqual(leadingSilenceSeconds - 0.1);
  });

  it('handles a short track where the first/last windows overlap without crashing', () => {
    const samples = clickTrain(10, 100); // well under the 30s window size
    const audio = makeDecodedAudio(samples);

    expect(() => analyzeTrack(audio)).not.toThrow();
    const { startWindow, endWindow } = analyzeTrack(audio);
    expect(startWindow.bpm).toBeGreaterThan(0);
    expect(endWindow.bpm).toBeGreaterThan(0);
  });
});

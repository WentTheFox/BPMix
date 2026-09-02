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

/**
 * mulberry32 - a small, deterministic (seeded) PRNG with good statistical
 * properties. A simple multiplicative LCG was tried first and rejected: its
 * low-order-bit structure produced spurious envelope-level periodicity
 * (>0.8 bpm confidence on pure "noise") strong enough to fool the comb
 * filter outright - not representative of real non-percussive audio at all.
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic (seeded), non-periodic noise - audible (above the silence threshold) but with nothing for a comb filter to lock onto, like a sparse/vocal-only intro or a breakdown. */
function noise(durationSeconds: number, amplitude = 0.05): Float32Array {
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  const random = mulberry32(42);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * (random() * 2 - 1);
  }
  return out;
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
  it('estimates start and end window bpm independently, and normalization gain', async () => {
    // Leading/trailing silence, 120bpm content in between - a long-enough
    // track that the first/last 30s analysis windows don't overlap.
    const samples = concat(silence(2), clickTrain(70, 120), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startWindow, endWindow, normalizationGain } = await analyzeTrack(audio);

    expect(startWindow.bpm).toBeGreaterThan(115);
    expect(startWindow.bpm).toBeLessThan(125);
    expect(endWindow.bpm).toBeGreaterThan(115);
    expect(endWindow.bpm).toBeLessThan(125);
    expect(normalizationGain).toBeGreaterThan(0);
  });

  it('anchors start/end beat positions in absolute track time, accounting for leading silence', async () => {
    const leadingSilenceSeconds = 3;
    const samples = concat(silence(leadingSilenceSeconds), clickTrain(70, 120), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startWindow } = await analyzeTrack(audio);

    // The beat anchor must fall after the leading silence, in the region
    // where content actually starts - not at some point inside the silence.
    expect(startWindow.beatAnchorSeconds).toBeGreaterThanOrEqual(leadingSilenceSeconds - 0.1);
  });

  it("finds the confident beat within the start window even when it doesn't kick in until well after the window begins (a vocal-only/non-percussive intro)", async () => {
    // 20s of non-periodic noise (audible, not silence) followed by 10s of a
    // clear 140bpm click train - exactly ANALYSIS_WINDOW_SECONDS together,
    // so the full-window estimate would dilute across all 30s of it.
    const samples = concat(silence(2), noise(20), clickTrain(10, 140), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startWindow } = await analyzeTrack(audio);

    expect(startWindow.bpm).toBeGreaterThan(135);
    expect(startWindow.bpm).toBeLessThan(145);
    expect(startWindow.bpmConfidence).toBeGreaterThan(0.3);
  });

  it("finds the confident beat within the end window even when it fades out before the window ends (a breakdown/outro)", async () => {
    // Mirror image for the end window: a clear 140bpm click train, then 20s
    // of non-periodic noise before the (already-trimmed) trailing silence.
    const samples = concat(silence(2), clickTrain(10, 140), noise(20), silence(2));
    const audio = makeDecodedAudio(samples);

    const { endWindow } = await analyzeTrack(audio);

    expect(endWindow.bpm).toBeGreaterThan(135);
    expect(endWindow.bpm).toBeLessThan(145);
    expect(endWindow.bpmConfidence).toBeGreaterThan(0.3);
  });

  it("keeps searching past the first ANALYSIS_WINDOW_SECONDS when nothing in it is confidently periodic at all (regression: a non-rhythmic intro longer than the in-window trims can reach - e.g. a long ambient build - previously left every candidate confidently-numbered-but-wrong, since it was still 'the best of' a region with no real beat)", async () => {
    const leadingSilenceSeconds = 2;
    const noiseSeconds = 40;
    const samples = concat(silence(leadingSilenceSeconds), noise(noiseSeconds), clickTrain(15, 140), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startWindow } = await analyzeTrack(audio);

    expect(startWindow.bpm).toBeGreaterThan(135);
    expect(startWindow.bpm).toBeLessThan(145);
    expect(startWindow.bpmConfidence).toBeGreaterThan(0.3);
  });

  it('keeps searching further back from the end when the outro is a longer non-rhythmic stretch too', async () => {
    const samples = concat(silence(2), clickTrain(15, 140), noise(40), silence(2));
    const audio = makeDecodedAudio(samples);

    const { endWindow } = await analyzeTrack(audio);

    expect(endWindow.bpm).toBeGreaterThan(135);
    expect(endWindow.bpm).toBeLessThan(145);
    expect(endWindow.bpmConfidence).toBeGreaterThan(0.3);
  });

  it('handles a short track where the first/last windows overlap without crashing', async () => {
    const samples = clickTrain(10, 100); // well under the 30s window size
    const audio = makeDecodedAudio(samples);

    await expect(analyzeTrack(audio)).resolves.toBeTruthy();
    const { startWindow, endWindow } = await analyzeTrack(audio);
    expect(startWindow.bpm).toBeGreaterThan(0);
    expect(endWindow.bpm).toBeGreaterThan(0);
  });
});

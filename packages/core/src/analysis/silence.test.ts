import { describe, expect, it } from 'vitest';
import type { DecodedAudio } from '../audio-engine/types';
import { findContentBounds } from './silence';

const SAMPLE_RATE = 44100;

function makeDecodedAudio(samples: Float32Array, numberOfChannels = 1): DecodedAudio {
  return {
    sampleRate: SAMPLE_RATE,
    numberOfChannels,
    channelData: Array.from({ length: numberOfChannels }, () => samples),
    durationSeconds: samples.length / SAMPLE_RATE,
  };
}

/** A pure tone loud enough to clear the silence threshold. */
function tone(durationSeconds: number, amplitude = 0.5, frequencyHz = 440): Float32Array {
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
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

describe('findContentBounds', () => {
  it('trims leading and trailing silence, keeping only the audible middle', async () => {
    const samples = concat(silence(2), tone(3), silence(2));
    const audio = makeDecodedAudio(samples);

    const { startSample, endSample } = await findContentBounds(audio);

    expect(startSample / SAMPLE_RATE).toBeCloseTo(2, 1);
    expect(endSample / SAMPLE_RATE).toBeCloseTo(5, 1);
  });

  it('leaves an already-tight track unchanged', async () => {
    const samples = tone(3);
    const audio = makeDecodedAudio(samples);

    const { startSample, endSample } = await findContentBounds(audio);

    expect(startSample).toBe(0);
    expect(endSample).toBeGreaterThan(samples.length - 1000); // right at (or essentially at) the end
  });

  it('falls back to the full range for an entirely silent track instead of an empty one', async () => {
    const audio = makeDecodedAudio(silence(3));

    const { startSample, endSample } = await findContentBounds(audio);

    expect(startSample).toBe(0);
    expect(endSample).toBe(audio.channelData[0]!.length);
  });

  it('mixes multiple channels down before measuring, not just the first', async () => {
    // Silent on channel 0 the whole way, but loud on channel 1 in the middle -
    // the mono mix should still see (and trim around) that content.
    const left = silence(5);
    const right = concat(silence(2), tone(1), silence(2));
    const audio: DecodedAudio = {
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      channelData: [left, right],
      durationSeconds: 5,
    };

    const { startSample, endSample } = await findContentBounds(audio);

    expect(startSample / SAMPLE_RATE).toBeCloseTo(2, 1);
    expect(endSample / SAMPLE_RATE).toBeCloseTo(3, 1);
  });
});

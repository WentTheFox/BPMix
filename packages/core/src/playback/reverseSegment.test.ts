import { describe, expect, it } from 'vitest';
import type { DecodedAudio } from '../audio-engine/types';
import { buildReversedSegment } from './reverseSegment';

function makeDecoded(samples: number[]): DecodedAudio {
  return {
    sampleRate: 1,
    numberOfChannels: 1,
    channelData: [Float32Array.from(samples)],
    durationSeconds: samples.length,
  };
}

describe('buildReversedSegment', () => {
  it('reverses the sample order within the requested range', () => {
    const decoded = makeDecoded([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const reversed = buildReversedSegment(decoded, 2, 6);
    expect(Array.from(reversed.channelData[0]!)).toEqual([5, 4, 3, 2]);
  });

  it('reverses every channel independently, keeping them aligned', () => {
    const decoded: DecodedAudio = {
      sampleRate: 1,
      numberOfChannels: 2,
      channelData: [Float32Array.from([0, 1, 2, 3]), Float32Array.from([10, 11, 12, 13])],
      durationSeconds: 4,
    };
    const reversed = buildReversedSegment(decoded, 0, 4);
    expect(Array.from(reversed.channelData[0]!)).toEqual([3, 2, 1, 0]);
    expect(Array.from(reversed.channelData[1]!)).toEqual([13, 12, 11, 10]);
  });

  it('reports durationSeconds matching the extracted frame count at the given sample rate', () => {
    const decoded: DecodedAudio = {
      sampleRate: 2,
      numberOfChannels: 1,
      channelData: [Float32Array.from(new Array(20).fill(0).map((_, i) => i))],
      durationSeconds: 10,
    };
    const reversed = buildReversedSegment(decoded, 1, 4);
    expect(reversed.durationSeconds).toBeCloseTo(3, 9);
    expect(reversed.channelData[0]!.length).toBe(6);
  });

  it('clamps to the available data instead of reading out of bounds', () => {
    const decoded = makeDecoded([0, 1, 2]);
    const reversed = buildReversedSegment(decoded, -5, 100);
    expect(Array.from(reversed.channelData[0]!)).toEqual([2, 1, 0]);
  });

  it('returns an empty segment when the range is empty or inverted', () => {
    const decoded = makeDecoded([0, 1, 2, 3]);
    expect(reversedLength(decoded, 2, 2)).toBe(0);
    expect(reversedLength(decoded, 3, 1)).toBe(0);
  });
});

function reversedLength(decoded: DecodedAudio, start: number, end: number): number {
  return buildReversedSegment(decoded, start, end).channelData[0]!.length;
}

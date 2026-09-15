import { describe, expect, it } from 'vitest';
import { parseDurationSeconds } from './parseDuration';

function concatBytes(parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function ascii(text: string): number[] {
  return Array.from(text).map((c) => c.charCodeAt(0));
}

/** Builds a minimal FLAC STREAMINFO block for the given sample rate/total sample count. */
function buildFlac(sampleRate: number, totalSamples: number): Uint8Array {
  // 20 bits sampleRate | 3 bits channels-1 | 5 bits bitsPerSample-1 | 36 bits totalSamples = 64 bits.
  const channelsMinus1 = 1n; // stereo
  const bitsPerSampleMinus1 = 15n; // 16-bit
  const packed =
    (BigInt(sampleRate) << 44n) | (channelsMinus1 << 41n) | (bitsPerSampleMinus1 << 36n) | BigInt(totalSamples);
  const packedBytes: number[] = [];
  for (let i = 7; i >= 0; i--) {
    packedBytes.push(Number((packed >> BigInt(i * 8)) & 0xffn));
  }
  return concatBytes([
    ascii('fLaC'),
    [0x00, 0x00, 0x00, 0x22], // block header: last-block flag set, type 0 (STREAMINFO), length 0x22 = 34
    [0x00, 0x00], // min block size
    [0x00, 0x00], // max block size
    [0x00, 0x00, 0x00], // min frame size
    [0x00, 0x00, 0x00], // max frame size
    packedBytes,
    new Array(16).fill(0), // MD5
  ]);
}

function buildWav(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Uint8Array {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const fmtChunk = concatBytes([
    ascii('fmt '),
    u32le(16),
    u16le(1), // PCM
    u16le(channels),
    u32le(sampleRate),
    u32le(byteRate),
    u16le(blockAlign),
    u16le(bitsPerSample),
  ]);
  const dataChunk = concatBytes([ascii('data'), u32le(dataBytes), new Array(dataBytes).fill(0)]);
  const riffSize = 4 + fmtChunk.length + dataChunk.length; // "WAVE" + chunks
  return concatBytes([ascii('RIFF'), u32le(riffSize), ascii('WAVE'), [...fmtChunk], [...dataChunk]]);
}

/** Builds a minimal MP4 box tree: ftyp (ignored) + moov > mvhd (version 0). */
function buildMp4(timescale: number, duration: number): Uint8Array {
  const mvhdPayload = concatBytes([
    [0, 0, 0, 0], // version 0 + flags
    u32be(0), // creation time
    u32be(0), // modification time
    u32be(timescale),
    u32be(duration),
  ]);
  const mvhdBox = concatBytes([u32be(8 + mvhdPayload.length), ascii('mvhd'), [...mvhdPayload]]);
  const moovBox = concatBytes([u32be(8 + mvhdBox.length), ascii('moov'), [...mvhdBox]]);
  const ftypBox = concatBytes([u32be(8 + 4), ascii('ftyp'), ascii('isom')]);
  return concatBytes([[...ftypBox], [...moovBox]]);
}

/** Builds a minimal MPEG1 Layer3 (MP3) frame header, optionally followed by a Xing header with a given frame count. */
function buildMp3Frame(options: { bitrateKbps: number; sampleRate: number; xingFrames?: number }): Uint8Array {
  const bitrateTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrateIndex = bitrateTable.indexOf(options.bitrateKbps);
  const sampleRateTable = [44100, 48000, 32000];
  const sampleRateIndex = sampleRateTable.indexOf(options.sampleRate);
  // byte0=0xFF, byte1: 111(sync) 11(MPEG1) 01(Layer3) 1(no CRC) = 0xFB
  const b1 = 0xfb;
  const b2 = (bitrateIndex << 4) | (sampleRateIndex << 2); // padding=0
  const b3 = 0xc0; // channelMode=11 (mono) for a predictable, small side-info offset
  const header = [0xff, b1, b2, b3];
  if (options.xingFrames === undefined) {
    return concatBytes([header, new Array(96).fill(0)]);
  }
  // Mono MPEG1 side info is 17 bytes, so Xing starts at header(4)+17=21.
  const xing = concatBytes([
    ascii('Xing'),
    u32be(0x1), // flags: frames field present
    u32be(options.xingFrames),
  ]);
  const sideInfo = new Array(17).fill(0);
  return concatBytes([header, sideInfo, [...xing], new Array(64).fill(0)]);
}

describe('parseDurationSeconds', () => {
  it('reads exact duration from a FLAC STREAMINFO block', () => {
    const bytes = buildFlac(44100, 44100 * 125); // 125 seconds
    expect(parseDurationSeconds(bytes, 'song.flac', bytes.length)).toBeCloseTo(125, 5);
  });

  it('reads exact duration from a WAV fmt/data chunk pair', () => {
    const sampleRate = 44100;
    const channels = 2;
    const bitsPerSample = 16;
    const seconds = 10;
    const dataBytes = sampleRate * channels * (bitsPerSample / 8) * seconds;
    const bytes = buildWav(sampleRate, channels, bitsPerSample, dataBytes);
    expect(parseDurationSeconds(bytes, 'song.wav', bytes.length)).toBeCloseTo(seconds, 5);
  });

  it('reads exact duration from an MP4 mvhd box (version 0)', () => {
    const bytes = buildMp4(1000, 90_000); // timescale 1000, duration 90000 -> 90s
    expect(parseDurationSeconds(bytes, 'song.m4a', bytes.length)).toBeCloseTo(90, 5);
  });

  it('returns null for an MP4 with no moov box in the prefix', () => {
    const bytes = concatBytes([u32be(16), ascii('ftyp'), ascii('isom'), [0, 0, 0, 0]]);
    expect(parseDurationSeconds(bytes, 'song.m4a', bytes.length)).toBeNull();
  });

  it('reads exact duration from an MP3 Xing frame-count header', () => {
    const sampleRate = 44100;
    const framesForTenSeconds = Math.round((sampleRate * 10) / 1152); // Layer3 MPEG1 = 1152 samples/frame
    const bytes = buildMp3Frame({ bitrateKbps: 128, sampleRate, xingFrames: framesForTenSeconds });
    const duration = parseDurationSeconds(bytes, 'song.mp3', bytes.length);
    expect(duration).not.toBeNull();
    expect(duration!).toBeCloseTo(10, 1);
  });

  it('estimates MP3 duration from bitrate when no Xing/VBRI header is present (CBR)', () => {
    const bitrateKbps = 128;
    const sampleRate = 44100;
    const frame = buildMp3Frame({ bitrateKbps, sampleRate });
    const totalSizeBytes = Math.round((bitrateKbps * 1000 * 30) / 8); // 30 seconds of audio at this bitrate
    const duration = parseDurationSeconds(frame, 'song.mp3', totalSizeBytes);
    expect(duration).not.toBeNull();
    expect(duration!).toBeCloseTo(30, 0);
  });

  it('skips a leading ID3v2 tag before looking for the MP3 frame sync', () => {
    const id3Size = 200;
    // Synchsafe-encoded size (only the low 7 bits of each byte count).
    const synchsafe = [(id3Size >> 21) & 0x7f, (id3Size >> 14) & 0x7f, (id3Size >> 7) & 0x7f, id3Size & 0x7f];
    const id3Header = concatBytes([ascii('ID3'), [3, 0, 0], synchsafe, new Array(id3Size).fill(0)]);
    const sampleRate = 44100;
    const framesForFiveSeconds = Math.round((sampleRate * 5) / 1152);
    const frame = buildMp3Frame({ bitrateKbps: 192, sampleRate, xingFrames: framesForFiveSeconds });
    const bytes = concatBytes([[...id3Header], [...frame]]);
    const duration = parseDurationSeconds(bytes, 'song.mp3', bytes.length);
    expect(duration).not.toBeNull();
    expect(duration!).toBeCloseTo(5, 1);
  });

  it('returns null for an unrecognized extension', () => {
    expect(parseDurationSeconds(new Uint8Array([1, 2, 3]), 'song.ogg', 3)).toBeNull();
  });

  it('returns null instead of throwing for a truncated/malformed prefix', () => {
    expect(parseDurationSeconds(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), 'song.flac', 4)).toBeNull();
    expect(parseDurationSeconds(new Uint8Array([0xff, 0xfb]), 'song.mp3', 2)).toBeNull();
  });
});

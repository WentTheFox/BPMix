import { describe, expect, it } from 'vitest';
import { id3v2TagLength, readEmbeddedLyrics } from './readEmbeddedLyrics';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const utf16le = (s: string) => [0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])];

function synchsafeBytes(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

function frame(version: 3 | 4, id: string, data: number[]): number[] {
  const size = version === 4 ? synchsafeBytes(data.length) : [(data.length >>> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff];
  return [...ascii(id), ...size, 0, 0, ...data];
}

function tag(version: 3 | 4, frames: number[][]): Uint8Array {
  const body = [...frames.flat(), 0, 0, 0, 0]; // trailing padding counts toward the tag size
  return Uint8Array.from([...ascii('ID3'), version, 0, 0, ...synchsafeBytes(body.length), ...body]);
}

const uslt = (encoding: number, descriptor: number[], text: number[]) => [encoding, ...ascii('eng'), ...descriptor, ...text];

describe('readEmbeddedLyrics', () => {
  it('reads UTF-8 USLT lyrics from an ID3v2.4 tag, skipping the other frames', () => {
    const lrc = '[00:01.00]Árvíztűrő\n[00:02.00]tükörfúrógép';
    const bytes = tag(4, [frame(4, 'TIT2', [3, ...utf8('Title')]), frame(4, 'USLT', uslt(3, [0], utf8(lrc)))]);
    expect(readEmbeddedLyrics(bytes)).toBe(lrc);
  });

  it('reads Latin-1 and UTF-16 lyrics (the descriptor ends at an aligned NUL pair there) from ID3v2.3', () => {
    expect(readEmbeddedLyrics(tag(3, [frame(3, 'USLT', uslt(0, [...ascii('desc'), 0], ascii('Hello\nWorld')))]))).toBe('Hello\nWorld');
    expect(readEmbeddedLyrics(tag(3, [frame(3, 'USLT', uslt(1, [...utf16le('d'), 0, 0], utf16le('Zażółć')))]))).toBe('Zażółć');
  });

  it('is null without a lyrics frame, an empty one, or no tag at all', () => {
    expect(readEmbeddedLyrics(tag(3, [frame(3, 'TIT2', [0, ...ascii('Title')])]))).toBeNull();
    expect(readEmbeddedLyrics(tag(3, [frame(3, 'USLT', uslt(0, [0], ascii('  ')))]))).toBeNull();
    expect(readEmbeddedLyrics(Uint8Array.from(ascii('not a tag at all')))).toBeNull();
  });

  it('is null (not a throw) for a frame that claims more bytes than the tag has', () => {
    const bytes = tag(3, [frame(3, 'USLT', uslt(0, [0], ascii('x')))]);
    bytes[17] = 0x7f; // inflate the frame size
    expect(readEmbeddedLyrics(bytes)).toBeNull();
  });

  it('measures the tag, header included', () => {
    const bytes = tag(3, [frame(3, 'TIT2', [0, ...ascii('T')])]);
    expect(id3v2TagLength(bytes)).toBe(bytes.length);
    expect(id3v2TagLength(Uint8Array.from(ascii('RIFFxxxxxxxxxx')))).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { decodeTrackKey, encodeTrackKey } from './trackKey';

describe('track keys', () => {
  it.each(['Music:Album/one.mp3', 'Léa: 日本語/こんにちは ♪.flac', 'a:b?c#d%2F e+f/=.mp3'])('round-trips %s', (fileId) => {
    const key = encodeTrackKey(fileId);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTrackKey(key)).toBe(fileId);
  });
});

import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from './encoding';

describe('encoding', () => {
  it('matches Node for UTF-8 and base64url across many strings, including astral characters and odd lengths', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const characters = Array.from('abcMúsica: Ünï/日本語.mp3😀🎵𝄞\u0000\u007f\u0080\u07ff\u0800\uffff');
    for (let n = 0; n < 500; n++) {
      let text = '';
      for (let i = 0; i < Math.floor(random() * 40); i++) text += characters[Math.floor(random() * characters.length)];
      const bytes = utf8Encode(text);
      expect(Buffer.from(bytes).equals(Buffer.from(text, 'utf8'))).toBe(true);
      expect(utf8Decode(bytes)).toBe(text);
      expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64UrlDecode(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
    }
    for (let length = 0; length < 12; length++) {
      const bytes = Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    }
  });

  it('round-trips every kind of character', () => {
    for (const text of ['', 'plain', 'Música — 日本語 😀 𝄞 \u0000 end']) expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('treats malformed input like TextDecoder: replacement characters, never an exception', () => {
    const cases: number[][] = [[0xff], [0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98], [0x41, 0x80, 0x42], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xe0, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x41], [0xf0, 0x9f, 0x41]];
    for (const bytes of cases) expect(utf8Decode(bytes), JSON.stringify(bytes)).toBe(new TextDecoder().decode(new Uint8Array(bytes)));
    // And over random bytes, which is mostly malformed.
    let seed = 99;
    for (let n = 0; n < 2000; n++) {
      const bytes = Array.from({ length: 1 + (n % 9) }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff);
      expect(utf8Decode(bytes), JSON.stringify(bytes)).toBe(new TextDecoder().decode(new Uint8Array(bytes)));
    }
  });

  it('replaces an unpaired surrogate with U+FFFD, as TextEncoder does', () => {
    expect(Buffer.from(utf8Encode('a\ud800b')).toString('utf8')).toBe('a�b');
  });

  it('rejects characters outside the base64url alphabet and ignores padding', () => {
    expect(() => base64UrlDecode('ab+/')).toThrow();
    expect(() => base64UrlDecode('a b')).toThrow();
    expect(base64UrlDecode('QQ==')).toEqual([65]);
  });
});

// UTF-8 and base64url in plain TypeScript. This package runs on React Native (Hermes), browsers and
// Node, and the globals that would normally do this (TextEncoder, atob, Buffer) aren't uniformly
// available or typed across them.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map(Array.from(ALPHABET, (c, i) => [c, i] as const));

export function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // A surrogate pair is one code point; an unpaired surrogate becomes U+FFFD, as TextEncoder does.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

/**
 * UTF-8 decoding as the WHATWG Encoding standard specifies (what TextDecoder does): every malformed
 * byte sequence becomes U+FFFD, never an exception, and the byte that broke a sequence is read again
 * as the start of the next one.
 */
export function utf8Decode(bytes: ArrayLike<number>): string {
  let out = '';
  let needed = 0;
  let seen = 0;
  let codePoint = 0;
  let lower = 0x80;
  let upper = 0xbf;
  const reset = () => {
    needed = seen = codePoint = 0;
    lower = 0x80;
    upper = 0xbf;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (needed === 0) {
      if (b <= 0x7f) out += String.fromCharCode(b);
      else if (b >= 0xc2 && b <= 0xdf) [needed, codePoint] = [1, b & 0x1f];
      else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        [needed, codePoint] = [2, b & 0x0f];
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        [needed, codePoint] = [3, b & 0x07];
      } else out += '\ufffd';
      continue;
    }
    if (b < lower || b > upper) {
      reset();
      out += '\ufffd';
      i--; // this byte may itself start a valid sequence
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    codePoint = (codePoint << 6) | (b & 0x3f);
    if (++seen === needed) {
      out += String.fromCodePoint(codePoint);
      reset();
    }
  }
  if (needed !== 0) out += '\ufffd'; // the input ended mid-sequence
  return out;
}

export function base64UrlEncode(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 63]!;
  }
  return out;
}

/** Throws on characters outside the base64url alphabet. Padding, if present, is ignored. */
export function base64UrlDecode(text: string): number[] {
  const clean = text.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = LOOKUP.get(char);
    if (value === undefined) throw new Error('Invalid base64url');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

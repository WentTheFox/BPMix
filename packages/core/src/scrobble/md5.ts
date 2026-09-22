/**
 * Pure-JS MD5 (RFC 1321), UTF-8 input -> lowercase hex digest. Last.fm's
 * API signing scheme (see lastfm.ts's buildApiSig) hard-requires MD5
 * specifically - it's a legacy scheme, not a choice we get to make - and no
 * dependency here can supply it consistently across all three targets
 * (browser, Android/Hermes, Windows/JSI) without either a native module or
 * a Node-only `crypto` import, so this is a small self-contained
 * implementation rather than pulling one in.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16,
  23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// floor(abs(sin(i + 1)) * 2^32) for i in 0..63, precomputed per RFC 1321.
const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function leftRotate(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

function toUtf8Bytes(input: string): number[] {
  // encodeURIComponent/unescape round-trip gives a UTF-8 byte sequence
  // without relying on TextEncoder, which some of this repo's older RN
  // Hermes targets don't reliably polyfill.
  const utf8 = unescape(encodeURIComponent(input));
  const bytes = new Array<number>(utf8.length);
  for (let i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i);
  return bytes;
}

/** MD5 hex digest of a UTF-8 string. */
export function md5(input: string): string {
  const bytes = toUtf8Bytes(input);
  const bitLength = bytes.length * 8;

  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLength / Math.pow(2, 8 * i)) & 0xff);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += 64) {
    const M = new Array<number>(16);
    for (let j = 0; j < 16; j++) {
      const o = chunkStart + j * 4;
      M[j] = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i]! + M[g]!) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + leftRotate(f, S[i]!)) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0].map(toLittleEndianHex).join('');
}

function toLittleEndianHex(word: number): string {
  let hex = '';
  for (let i = 0; i < 4; i++) {
    hex += (((word >>> (i * 8)) & 0xff) + 0x100).toString(16).slice(1);
  }
  return hex;
}

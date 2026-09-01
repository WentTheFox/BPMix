const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Self-contained base64 decoder, since react-native-scoped-storage's readFile
 * only returns strings (utf8/base64/ascii) and we can't assume Hermes has a
 * global atob available across the RN versions this app might run on.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const lookup = new Uint8Array(256);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    lookup[BASE64_CHARS.charCodeAt(i)] = i;
  }

  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLength = Math.floor((clean.length * 3) / 4) - padding;
  const bytes = new Uint8Array(byteLength);

  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = lookup[clean.charCodeAt(i)] ?? 0;
    const c1 = lookup[clean.charCodeAt(i + 1)] ?? 0;
    const c2 = lookup[clean.charCodeAt(i + 2)] ?? 0;
    const c3 = lookup[clean.charCodeAt(i + 3)] ?? 0;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;

    if (byteIndex < byteLength) bytes[byteIndex++] = (triple >> 16) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = (triple >> 8) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = triple & 0xff;
  }

  return bytes.buffer;
}

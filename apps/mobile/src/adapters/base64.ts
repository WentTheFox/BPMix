import { toByteArray } from 'base64-js';

/**
 * react-native-scoped-storage's readFile only returns strings (utf8/base64/
 * ascii) - there's no way to read a content:// SAF file as raw bytes
 * directly, so decoding a base64 string back to bytes here is unavoidable
 * for every file read (most importantly, the whole audio file on every
 * track decode). This used to be a hand-rolled decoder that rebuilt its
 * lookup table on every call and ran a regex pass over the entire string
 * before the main loop - for a multi-MB audio file (multi-million-character
 * base64 string), that was a genuine multi-second stall on the JS thread,
 * confirmed on-device as the dominant cause of a severe freeze right at
 * track-switch time. base64-js (already vendored transitively by
 * react-native itself, for Blob/WebSocket) builds its lookup table once at
 * module load and has no such per-call overhead.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = toByteArray(base64);
  // Always a plain (non-shared, exactly byteLength-sized) ArrayBuffer in
  // practice - toByteArray allocates a fresh Uint8Array itself - but its
  // .d.ts types .buffer as the more general ArrayBufferLike.
  return bytes.buffer as ArrayBuffer;
}

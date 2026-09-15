/**
 * FNV-1a over the given bytes, as a hex string - same algorithm/house style
 * as apps/mobile's libraryStore.android.ts/.windows.ts coverArtFileName
 * (there, over a string; here, over raw file bytes). Not cryptographic -
 * this is purely a "did this file's content change" signal tied to
 * TrackMetadata (see its contentHash field), not a security boundary, so
 * FNV-1a's real but astronomically small collision risk for a single
 * file's before/after content is an acceptable tradeoff for staying a
 * simple, dependency-free loop (no Web Crypto/crypto.subtle, which Hermes
 * doesn't provide) fast enough to run on multi-MB audio files.
 */
export function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

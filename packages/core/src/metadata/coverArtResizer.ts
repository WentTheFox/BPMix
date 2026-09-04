/**
 * Platform-specific cover art downscaling - implemented per-platform (web:
 * Canvas; Android: @bam.tech/react-native-image-resizer via a temp file;
 * Windows: WinRT BitmapDecoder/Transform/Encoder in the native module)
 * since packages/core has to stay platform-agnostic and testable under
 * plain Node. Optional: ensureTrackMetadata falls back to a hard byte-size
 * cutoff (see MAX_COVER_ART_BYTES) for any platform/track this doesn't
 * shrink enough.
 */
export interface CoverArtResizer {
  /**
   * Resizes/re-encodes image bytes so neither dimension exceeds
   * maxDimensionPx, returning null when resizing didn't happen (already
   * small enough, or the platform couldn't decode/re-encode it) - the
   * caller then falls back to the original bytes.
   */
  resize(bytes: Uint8Array, mimeType: string, maxDimensionPx: number): Promise<{ mimeType: string; bytes: Uint8Array } | null>;
}

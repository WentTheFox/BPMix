import sharp from 'sharp';
import type { CoverArtResizer } from '@bpmix/core';

/** Downscales oversized embedded art to a WebP no larger than maxDimensionPx on either side. */
export const sharpCoverArtResizer: CoverArtResizer = {
  async resize(bytes, _mimeType, maxDimensionPx) {
    try {
      const out = await sharp(bytes).resize(maxDimensionPx, maxDimensionPx, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      return { mimeType: 'image/webp', bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
    } catch {
      // Unreadable/unsupported image: callers treat null as "keep the original or drop it".
      return null;
    }
  },
};

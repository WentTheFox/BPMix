import type { CoverArtResizer } from '@bpmix/core';

const OUTPUT_MIME_TYPE = 'image/jpeg';
const OUTPUT_QUALITY = 0.85;

/** Canvas-based downscale: decode via createImageBitmap, draw scaled onto a 2D canvas, re-encode as JPEG - all built-in browser APIs, no dependency needed. */
export function createCoverArtResizer(): CoverArtResizer {
  return {
    async resize(bytes, mimeType, maxDimensionPx) {
      // TS's DOM lib types BlobPart as requiring an ArrayBuffer-backed view
      // (not the wider ArrayBufferLike Uint8Array's own type uses, to also
      // cover SharedArrayBuffer) - a plain Uint8Array is always valid at
      // runtime here, this is just narrowing the type back down.
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        return null; // undecodable (corrupt/unsupported format) - caller falls back to the raw bytes
      }
      try {
        if (bitmap.width <= maxDimensionPx && bitmap.height <= maxDimensionPx) {
          return null; // already small enough
        }
        const scale = maxDimensionPx / Math.max(bitmap.width, bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, width, height);

        const outBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, OUTPUT_MIME_TYPE, OUTPUT_QUALITY));
        if (!outBlob) return null;
        const buffer = await outBlob.arrayBuffer();
        return { mimeType: OUTPUT_MIME_TYPE, bytes: new Uint8Array(buffer) };
      } finally {
        bitmap.close();
      }
    },
  };
}

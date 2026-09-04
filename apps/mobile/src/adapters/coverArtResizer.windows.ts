import { encodeBase64, type CoverArtResizer } from '@bpmix/core';
import { NativeModules } from 'react-native';
import { base64ToArrayBuffer } from './base64';

/** See windows/Mobile/CoverArtResizerModule.h - WinRT's BitmapDecoder/BitmapTransform/BitmapEncoder do the actual decode/resize/re-encode; this just handles the base64 bridge crossing (same convention as fileAccess.windows.ts's readFileBytesBase64). */
interface NativeCoverArtResizer {
  resizeImage(base64Data: string, maxDimensionPx: number): Promise<{ mimeType: string; base64: string } | null>;
}

const native = NativeModules.BPMixCoverArtResizer as NativeCoverArtResizer;

export function createCoverArtResizer(): CoverArtResizer {
  return {
    async resize(bytes, _mimeType, maxDimensionPx) {
      const resized = await native.resizeImage(encodeBase64(bytes), maxDimensionPx);
      if (!resized) return null;
      return { mimeType: resized.mimeType, bytes: new Uint8Array(base64ToArrayBuffer(resized.base64)) };
    },
  };
}

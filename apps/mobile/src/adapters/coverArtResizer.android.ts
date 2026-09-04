import { encodeBase64, type CoverArtResizer } from '@bpmix/core';
import ImageResizer from '@bam.tech/react-native-image-resizer';

const OUTPUT_QUALITY = 85;

/**
 * @bam.tech/react-native-image-resizer (the maintained fork of the
 * standard react-native-image-resizer) - Android/iOS only, no Windows
 * implementation (see CoverArtResizerModule.h for that platform's own
 * WinRT-based one instead).
 *
 * Its native Android code explicitly supports a "data:<mime>;base64,..."
 * string as the input `uri` (see its ImageResizer.java's
 * loadBitmapFromBase64), so no temp file write is needed for the input.
 * The output, though, is always written to a real file - read back via
 * fetch() (RN's networking layer resolves local file:// URIs), same as
 * this project's other "read a small local file into bytes" needs.
 */
export function createCoverArtResizer(): CoverArtResizer {
  return {
    async resize(bytes, mimeType, maxDimensionPx) {
      const dataUri = `data:${mimeType};base64,${encodeBase64(bytes)}`;
      const response = await ImageResizer.createResizedImage(dataUri, maxDimensionPx, maxDimensionPx, 'JPEG', OUTPUT_QUALITY, 0, null, false, {
        mode: 'contain',
        onlyScaleDown: true,
      });
      const fetched = await fetch(response.uri);
      const outBytes = new Uint8Array((await fetched.arrayBuffer()) as ArrayBuffer);
      return { mimeType: 'image/jpeg', bytes: outBytes };
    },
  };
}

/// <reference path="./jsmediatags.d.ts" />
// A direct subpath import, not the bare 'jsmediatags' specifier (whose
// package.json "browser" field points to this same file, but that field
// only applies when a bundler is configured to honor it - Vite's
// dependency pre-bundling doesn't, so it instead resolves "main"
// (build2/jsmediatags.js), which unconditionally requires NodeFileReader/
// ReactNativeFileReader and so pulls in 'fs'/'react-native-fs', neither
// installed here). This prebuilt bundle was specifically built without
// those two readers (browserify -i), so it only needs the ArrayFileReader
// path this module actually uses.
import { Reader, type PictureType } from 'jsmediatags/dist/jsmediatags.min.js';

export interface ParsedTags {
  title: string | null;
  artists: string[];
  album: string | null;
  /** Raw, un-resized, un-encoded - see ensureTrackMetadata for the resize/size-cutoff/data-URI-encoding pipeline downstream of this. */
  coverArt: { mimeType: string; data: Uint8Array } | null;
}

/** Splits a multi-artist tag value into individual names: ID3v2.4 separates multiple TPE1 values with NUL, v2.3 conventionally uses "/". */
function splitArtists(raw: string): string[] {
  return raw
    .split(/\0|\//)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** ID3v2.3+/MP4/FLAC give a real MIME type; only ID3v2.2's 3-char image type ("JPG"/"PNG") doesn't. */
function normalizeMimeType(format: string): string {
  if (format.includes('/')) return format;
  const upper = format.toUpperCase();
  if (upper === 'JPG' || upper === 'JPEG') return 'image/jpeg';
  if (upper === 'PNG') return 'image/png';
  return 'image/jpeg'; // most embedded art is jpeg; a wrong guess here just fails to decode rather than crashing anything
}

function parseCoverArt(picture: PictureType | undefined): ParsedTags['coverArt'] {
  if (!picture || picture.data.length === 0) return null;
  return { mimeType: normalizeMimeType(picture.format), data: new Uint8Array(picture.data) };
}

/**
 * Reads ID3v1/ID3v2/MP4/FLAC tags via jsmediatags rather than hand-rolling
 * a binary tag parser, since the format's edge cases (synchsafe sizes,
 * extended headers, half a dozen text encodings, three tag format
 * generations) are exactly what a maintained library exists to get right.
 * Only title/artist/album/cover art are read - the fields the library
 * screen displays.
 *
 * jsmediatags is handed a plain byte array rather than the raw
 * ArrayBuffer: its bundled ArrayFileReader (the reader that works from
 * already-in-memory bytes, as opposed to a DOM Blob/File, a Node fs path,
 * or an XHR URL - none of which fit FileAccess's cross-platform file
 * handles) only recognizes `Array.isArray` or a `Buffer`, neither of
 * which an ArrayBuffer/Uint8Array satisfies.
 */
export function readTags(fileBytes: ArrayBuffer): Promise<ParsedTags | null> {
  const byteArray = Array.from(new Uint8Array(fileBytes));
  return new Promise((resolve) => {
    new Reader(byteArray)
      .setTagsToRead(['title', 'artist', 'album', 'picture'])
      .read({
        onSuccess: (tag) => {
          const { title, artist, album, picture } = tag.tags;
          resolve({
            title: title?.trim() || null,
            artists: artist ? splitArtists(artist) : [],
            album: album?.trim() || null,
            coverArt: parseCoverArt(picture),
          });
        },
        // No supported tag found (or a malformed one) - that's "no metadata for this file", not a scan failure.
        onError: () => resolve(null),
      });
  });
}

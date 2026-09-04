import type { FileAccess, FileRef } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import type { CoverArtResizer } from './coverArtResizer';
import { readTags } from './readTags';
import type { CoverArtBytes, TrackMetadata } from './types';

/** Bumped whenever readTags' behavior changes, so already-scanned files get re-read instead of keeping a stale result forever - same role as ANALYSIS_ALGORITHM_VERSION. (v2: also extracts cover art. v3: downscales/cuts off oversized art instead of storing it verbatim - a bump here is what gets already-v2-scanned tracks' oversized art reprocessed, not just newly-scanned ones.) */
export const METADATA_PARSER_VERSION = 3;

/** Cover art is only ever displayed at small thumbnail sizes - shrink it toward this before storing. */
export const COVER_ART_MAX_DIMENSION_PX = 300;

/**
 * Hard fallback for any track a CoverArtResizer isn't available for, or
 * doesn't manage to shrink enough: some embedded art is a needlessly
 * full-resolution scan (a real one seen in testing: ~1MB raw) despite only
 * ever being displayed at a small thumbnail size - drop it entirely rather
 * than let a handful of oversized outliers dominate the library's storage
 * footprint. A file over this simply gets no stored art, same as one with
 * none.
 */
const MAX_COVER_ART_BYTES = 500_000;

/** True if a stored TrackMetadata can still be trusted for the given file - see TrackMetadata's field docs and isAnalysisFresh (the same pattern, for analysis results). */
export function isMetadataFresh(
  existing: TrackMetadata | null,
  ref: Pick<FileRef, 'sizeBytes' | 'lastModifiedMs'>,
): existing is TrackMetadata {
  return (
    existing !== null &&
    existing.sizeBytes === ref.sizeBytes &&
    existing.lastModifiedMs === ref.lastModifiedMs &&
    existing.parserVersion === METADATA_PARSER_VERSION
  );
}

/**
 * Weaker than isMetadataFresh - doesn't need the file's current
 * size/mtime, just whether the metadata came from the current parser
 * version. useTrackMetadata displays a result immediately even when it's
 * from an older version (so title/artist don't regress to the filename
 * while a background rescan is still catching up to this track), so UI
 * code gating some OTHER lazy fetch on "metadata is confirmed current"
 * (see useCoverArt) needs this instead of a plain null check - the
 * stale-but-non-null case is exactly when that other fetch would race
 * ahead of the rescan and never retry.
 */
export function isMetadataCurrent(metadata: TrackMetadata | null): boolean {
  return metadata?.parserVersion === METADATA_PARSER_VERSION;
}

/**
 * Downscales art via the given resizer when it's larger than
 * COVER_ART_MAX_DIMENSION_PX (the resizer itself also treats "already
 * small enough" as a no-op, returning null - this only calls it at all to
 * avoid the overhead when the size cutoff alone will pass it through
 * untouched anyway), falls back to the raw bytes if there's no resizer or
 * it declines, and finally drops anything still over MAX_COVER_ART_BYTES.
 * Returns raw bytes, not an encoded string - it's up to each LibraryStore
 * adapter how to persist/serve them (see LibraryStore.putCoverArt's doc).
 */
async function resolveCoverArt(
  coverArt: CoverArtBytes | null,
  resizer: CoverArtResizer | undefined,
): Promise<CoverArtBytes | null> {
  if (!coverArt) return null;
  let { mimeType, data } = coverArt;
  if (resizer && data.length > MAX_COVER_ART_BYTES) {
    const resized = await resizer.resize(data, mimeType, COVER_ART_MAX_DIMENSION_PX);
    if (resized) {
      mimeType = resized.mimeType;
      data = resized.bytes;
    }
  }
  if (data.length > MAX_COVER_ART_BYTES) return null;
  return { mimeType, data };
}

/**
 * Returns the track's cached metadata if still fresh (isMetadataFresh),
 * otherwise reads the file's bytes, parses whatever tags it has (a file
 * with none still gets a stored result - null title/album, empty artists -
 * so callers can tell "scanned, no tags" apart from "not scanned yet"
 * without re-reading the file every time), and persists it.
 *
 * `resizer`, when given, downscales oversized embedded art before storing
 * it - see resolveCoverArt.
 */
export async function ensureTrackMetadata(
  store: LibraryStore,
  fileAccess: FileAccess,
  ref: FileRef,
  resizer?: CoverArtResizer,
): Promise<TrackMetadata> {
  const existing = await store.getMetadata(ref.id);
  if (isMetadataFresh(existing, ref)) {
    return existing;
  }
  const bytes = await fileAccess.readFileBytes(ref);
  const tags = await readTags(bytes);
  const result: TrackMetadata = {
    fileId: ref.id,
    title: tags?.title ?? null,
    artists: tags?.artists ?? [],
    album: tags?.album ?? null,
    sizeBytes: ref.sizeBytes,
    lastModifiedMs: ref.lastModifiedMs,
    parserVersion: METADATA_PARSER_VERSION,
  };
  await store.putMetadata(result);
  // Always written, even when null - clears stale art from a prior scan if
  // the file changed and no longer has any (or never did).
  await store.putCoverArt(ref.id, await resolveCoverArt(tags?.coverArt ?? null, resizer));
  return result;
}

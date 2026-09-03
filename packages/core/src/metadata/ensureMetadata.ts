import type { FileAccess, FileRef } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import { readTags } from './readTags';
import type { TrackMetadata } from './types';

/** Bumped whenever readTags' behavior changes, so already-scanned files get re-read instead of keeping a stale result forever - same role as ANALYSIS_ALGORITHM_VERSION. (v2: also extracts cover art.) */
export const METADATA_PARSER_VERSION = 2;

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
 * Returns the track's cached metadata if still fresh (isMetadataFresh),
 * otherwise reads the file's bytes, parses whatever tags it has (a file
 * with none still gets a stored result - null title/album, empty artists -
 * so callers can tell "scanned, no tags" apart from "not scanned yet"
 * without re-reading the file every time), and persists it.
 */
export async function ensureTrackMetadata(store: LibraryStore, fileAccess: FileAccess, ref: FileRef): Promise<TrackMetadata> {
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
  await store.putCoverArt(ref.id, tags?.coverArtDataUri ?? null);
  return result;
}

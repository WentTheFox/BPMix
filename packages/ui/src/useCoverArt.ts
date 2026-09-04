import type { LibraryStore } from '@bpmix/core';
import { useEffect, useState } from 'react';

/**
 * Per-session cache of resolved art (fileId -> data URI, or null for "no
 * art") - keeps re-mounts (e.g. scrolling a track list back over rows
 * already seen) from re-fetching from the store every time.
 */
const cache = new Map<string, string | null>();

/**
 * A row that's only passing through during a fast scroll mounts and
 * unmounts well within this window - deferring the fetch (and so the
 * <Image> mount and its decode, the actual expensive part, particularly
 * for a not-yet-resized track still carrying its original embedded art -
 * see COVER_ART_MAX_DIMENSION_PX) by this long means that row never pays
 * for either. A row the user actually stops on clears the delay
 * comfortably.
 */
const FETCH_DELAY_MS = 120;

/**
 * Lazily fetches a track's cover art - "lazily" in three senses: each
 * row's own hook instance only fires once it actually mounts (a
 * virtualized FlatList already limits that to visible rows), it waits for
 * `metadataReady` before asking the store at all, since cover art is
 * written in the same ensureTrackMetadata() pass as title/artist/album
 * (see scanLibraryMetadata) - fetching before that pass has run would just
 * see "not there yet" and (unlike useTrackMetadata) there's no cheap way
 * to tell that apart from "this file genuinely has no art", so this
 * doesn't retry-poll the way useTrackMetadata/useTrackAnalysis do - and it
 * debounces by FETCH_DELAY_MS so a fast scroll's rapid mount/unmount
 * churn doesn't fetch (and decode) art for rows never actually seen.
 */
export function useCoverArt(libraryStore: LibraryStore, fileId: string | null, metadataReady: boolean): string | null {
  const [dataUri, setDataUri] = useState<string | null>(() => (fileId ? (cache.get(fileId) ?? null) : null));
  useEffect(() => {
    if (!fileId || !metadataReady) {
      setDataUri(fileId ? (cache.get(fileId) ?? null) : null);
      return;
    }
    if (cache.has(fileId)) {
      setDataUri(cache.get(fileId) ?? null);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(() => {
      libraryStore.getCoverArt(fileId).then((uri) => {
        if (cancelled) return;
        cache.set(fileId, uri);
        setDataUri(uri);
      });
    }, FETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [libraryStore, fileId, metadataReady]);
  return dataUri;
}

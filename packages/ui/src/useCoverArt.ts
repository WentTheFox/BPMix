import type { LibraryStore } from '@bpmix/core';
import { useEffect, useState } from 'react';

/**
 * Per-session cache of resolved art (fileId -> data URI, or null for "no
 * art") - keeps re-mounts (e.g. scrolling a track list back over rows
 * already seen) from re-fetching from the store every time.
 */
const cache = new Map<string, string | null>();

/**
 * Lazily fetches a track's cover art - "lazily" in two senses: each row's
 * own hook instance only fires once it actually mounts (a virtualized
 * FlatList already limits that to visible rows), and it waits for
 * `metadataReady` before asking the store at all, since cover art is
 * written in the same ensureTrackMetadata() pass as title/artist/album
 * (see scanLibraryMetadata) - fetching before that pass has run would just
 * see "not there yet" and (unlike useTrackMetadata) there's no cheap way
 * to tell that apart from "this file genuinely has no art", so this
 * doesn't retry-poll the way useTrackMetadata/useTrackAnalysis do.
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
    libraryStore.getCoverArt(fileId).then((uri) => {
      if (cancelled) return;
      cache.set(fileId, uri);
      setDataUri(uri);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryStore, fileId, metadataReady]);
  return dataUri;
}

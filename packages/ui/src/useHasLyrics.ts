import type { LibraryStore } from '@bpmix/core';
import { useEffect, useState } from 'react';

/** Per-session cache (fileId -> has an assignment) - same reasoning as useCoverArt's cache: a row re-mounted by fast scrolling shouldn't re-ask the store every time. */
const cache = new Map<string, boolean>();

/**
 * Whether a track currently has a lyrics file assigned (auto-matched or
 * manual) - purely for the small "has lyrics" indicator on TrackRow, a
 * quick visual way to tell (while testing, and for the user in general)
 * which tracks in a list already have lyrics without opening each one.
 */
export function useHasLyrics(libraryStore: LibraryStore, fileId: string): boolean {
  const [hasLyrics, setHasLyrics] = useState(() => cache.get(fileId) ?? false);
  useEffect(() => {
    if (cache.has(fileId)) {
      setHasLyrics(cache.get(fileId)!);
      return;
    }
    let cancelled = false;
    libraryStore.getLyricsAssignment(fileId).then((assignment) => {
      if (cancelled) return;
      const has = assignment !== null;
      cache.set(fileId, has);
      setHasLyrics(has);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryStore, fileId]);
  return hasLyrics;
}

/** Clears the cache for one track - call after assigning/removing lyrics from LyricsSection so a stale "no lyrics" row doesn't linger. */
export function invalidateHasLyricsCache(fileId: string): void {
  cache.delete(fileId);
}

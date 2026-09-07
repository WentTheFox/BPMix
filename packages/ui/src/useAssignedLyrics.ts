import { loadAssignedLyrics, type FileAccess, type LibraryStore, type LyricsScope, type ParsedLyrics } from '@bpmix/core';
import { useEffect, useState } from 'react';

/** `undefined` while loading, `null` once loaded with no lyrics assigned/found. */
export type AssignedLyrics = ParsedLyrics | null | undefined;

/**
 * Loads whatever lyrics are currently assigned to a track (see
 * loadAssignedLyrics), re-fetching whenever the track, the configured
 * lyrics scopes, or `reloadToken` change - the picker (LyricsPickerScreen)
 * bumps reloadToken after writing a new assignment so this doesn't have to
 * poll for a change made by the app's own action.
 */
export function useAssignedLyrics(
  fileAccess: FileAccess,
  libraryStore: LibraryStore,
  scopes: LyricsScope[],
  trackFileId: string | null,
  reloadToken = 0,
): AssignedLyrics {
  const [lyrics, setLyrics] = useState<AssignedLyrics>(undefined);
  useEffect(() => {
    setLyrics(undefined);
    if (!trackFileId) return;
    let cancelled = false;
    loadAssignedLyrics(fileAccess, libraryStore, scopes, trackFileId).then((result) => {
      if (!cancelled) setLyrics(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fileAccess, libraryStore, scopes, trackFileId, reloadToken]);
  return lyrics;
}

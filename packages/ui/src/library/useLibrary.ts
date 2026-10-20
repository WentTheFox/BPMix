import { libraryErrorSet, lyricsScopesLoaded, selectMissingFileIds, selectRootsWithLibrary } from '@bpmix/core';
import type { GrantedRoot, LyricsScope, RootWithLibrary } from '@bpmix/core';
import { useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';

export interface LibraryView {
  rootsWithLibrary: RootWithLibrary[];
  grantedRoots: GrantedRoot[];
  /** True until refresh's first pass resolves `rootsWithLibrary` at least once. */
  isLoadingRoots: boolean;
  lyricsScopes: LyricsScope[];
  matchedLyricsCount: number | null;
  /** The direct-action error banner (addFolder, rescan, etc.). */
  error: string | null;
  missingFileIds: ReadonlySet<string>;
  setError: (message: string | null) => void;
  setLyricsScopes: (scopes: LyricsScope[]) => void;
}

/**
 * The store's `library` slice (see @bpmix/core's store/library) as a view
 * plus stable setters, shared by both apps. Loading is done by the
 * refreshLibrary thunk, not here.
 */
export function useLibrary(): LibraryView {
  const dispatch = useAppDispatch();
  const rootsWithLibrary = useAppSelector(selectRootsWithLibrary);
  const grantedRoots = useAppSelector((s) => s.library.grantedRoots);
  const isLoadingRoots = useAppSelector((s) => s.library.isLoadingRoots);
  const lyricsScopes = useAppSelector((s) => s.library.lyricsScopes);
  const matchedLyricsCount = useAppSelector((s) => s.library.matchedLyricsCount);
  const error = useAppSelector((s) => s.library.error);
  const missingFileIds = useAppSelector(selectMissingFileIds);
  const actions = useMemo(
    () => ({
      setError: (message: string | null) => dispatch(libraryErrorSet(message)),
      setLyricsScopes: (scopes: LyricsScope[]) => dispatch(lyricsScopesLoaded(scopes)),
    }),
    [dispatch],
  );
  return { rootsWithLibrary, grantedRoots, isLoadingRoots, lyricsScopes, matchedLyricsCount, error, missingFileIds, ...actions };
}

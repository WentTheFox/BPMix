import { scanLibraryMetadataQueued, type CoverArtResizer, type FileAccess, type LibraryStore, type PlaylistRecord, type TrackRecord } from '@bpmix/core';
import { useEffect } from 'react';

export interface OpenPlaylistMetadataScanInput {
  fileAccess: FileAccess;
  libraryStore: LibraryStore;
  resizer?: CoverArtResizer;
  /** Whatever's currently on screen - only a 'playlist' screen (including the virtual Unplaylisted one) triggers a scan. */
  screen: { kind: 'library' } | { kind: 'playlist'; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };
}

/**
 * Bumps metadata scanning for whichever playlist (or the Unplaylisted view,
 * itself a virtual playlist - see handleShowUnplaylisted) is actually open,
 * ahead of the whole-library 'background' pass refresh() already kicks off.
 * Without this, opening a playlist the background pass hasn't reached yet
 * left every row showing its raw filename until that pass caught up -
 * confirmed live by opening Unplaylisted (a root with hundreds of tracks)
 * while the background scan was still working through an earlier-opened
 * playlist's tracks.
 *
 * Keyed by playlist id (scanLibraryMetadataQueued's `task.id`), so
 * reopening the same playlist while its own pass is still running joins
 * that pass (see runJoinableTask) instead of starting a second one, and
 * switching to a different playlist starts a new, separately-tracked pass
 * rather than reusing the old one - the old pass is left to finish on its
 * own (its tracks still need scanning eventually; it's just no longer the
 * one the user is looking at). 'visible' priority (see taskQueue.ts) so
 * this doesn't wait behind the background pass, but still steps aside for
 * anything 'foreground' (Add Folder, Rescan, opening Unplaylisted itself).
 */
export function useOpenPlaylistMetadataScan(input: OpenPlaylistMetadataScanInput): void {
  const { fileAccess, libraryStore, resizer, screen } = input;
  useEffect(() => {
    if (screen.kind !== 'playlist') return;
    const tracks = [...screen.tracksById.values()].filter((t) => !t.missing);
    if (tracks.length === 0) return;
    void scanLibraryMetadataQueued(
      { id: `metadata-scan-playlist:${screen.playlist.id}`, label: `Scanning metadata for "${screen.playlist.name}"`, priority: 'visible' },
      fileAccess,
      libraryStore,
      tracks,
      { resizer },
    );
  }, [screen, fileAccess, libraryStore, resizer]);
}

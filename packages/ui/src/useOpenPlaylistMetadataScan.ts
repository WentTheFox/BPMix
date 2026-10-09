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
 * Uses one shared task id across every playlist, with `joinKey` set to the
 * playlist id: reopening the same playlist while its own pass is still
 * running joins that pass (see runJoinableTask) instead of starting a
 * second one, and switching to a different playlist supersedes the old
 * one via the shared id (runLatestTask's same-id dedup) instead of merely
 * queueing behind it - taskQueue.ts's checkpoint() makes an already-
 * running superseded pass yield at its next checkpoint, so the newly-
 * opened playlist's scan doesn't sit waiting behind a same-priority 'visible'
 * pass for a playlist that's no longer even on screen (confirmed live:
 * opening a second playlist while the first's scan was still running left
 * the second one waiting the entire time instead of jumping ahead, since
 * equal-priority work doesn't normally preempt itself). The superseded
 * pass isn't stopped outright - it still finishes eventually, whenever
 * nothing else wants the queue, since its tracks do need scanning too.
 * 'visible' priority (see taskQueue.ts) so this doesn't wait behind the
 * whole-library background pass, but still steps aside for anything
 * 'foreground' (Add Folder, Rescan, opening Unplaylisted itself).
 */
export function useOpenPlaylistMetadataScan(input: OpenPlaylistMetadataScanInput): void {
  const { fileAccess, libraryStore, resizer, screen } = input;
  useEffect(() => {
    if (screen.kind !== 'playlist') return;
    const tracks = [...screen.tracksById.values()].filter((t) => !t.missing);
    if (tracks.length === 0) return;
    void scanLibraryMetadataQueued(
      { id: 'metadata-scan-open-playlist', label: `Scanning metadata for "${screen.playlist.name}"`, priority: 'visible', joinKey: screen.playlist.id },
      fileAccess,
      libraryStore,
      tracks,
      { resizer },
    );
  }, [screen, fileAccess, libraryStore, resizer]);
}

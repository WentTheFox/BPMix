import type { OfflineLibrary, OfflineState } from '@bpmix/core';
import { useCallback, useSyncExternalStore } from 'react';

export interface UseOfflineResult {
  state: OfflineState;
  isAvailable: (fileId: string) => boolean;
  downloadTracks: (fileIds: string[]) => void;
  removeTracks: (fileIds: string[]) => void;
  cancelAll: () => void;
  resume: () => void;
  clear: () => void;
  setBudgetBytes: (bytes: number) => void;
  setCacheOnPlay: (on: boolean) => void;
  isPinned: (fileId: string) => boolean;
}

const EMPTY_STATE: OfflineState = { downloadedCount: 0, downloadedBytes: 0, queuedCount: 0, activeCount: 0, requestedCount: 0, progress: {}, budgetBytes: 0, cacheOnPlay: false, paused: false, failures: [] };

/** Offline downloads as React state. Null where a platform has no offline storage (yet), which hides the controls. */
export function useOffline(library: OfflineLibrary | undefined): UseOfflineResult | null {
  const state = useSyncExternalStore(
    useCallback((onChange: () => void) => library?.subscribe(onChange) ?? (() => undefined), [library]),
    () => library?.getState() ?? EMPTY_STATE,
  );
  if (!library) return null;
  return {
    state,
    isAvailable: (fileId) => library.isAvailable(fileId),
    downloadTracks: (fileIds) => library.request(fileIds, { pin: true }),
    removeTracks: (fileIds) => void library.remove(fileIds),
    cancelAll: () => library.cancelAll(),
    resume: () => library.resume(),
    clear: () => void library.clear(),
    setBudgetBytes: (bytes) => void library.setBudgetBytes(bytes),
    setCacheOnPlay: (on) => void library.setCacheOnPlay(on),
    isPinned: (fileId) => library.isPinned(fileId),
  };
}

export type OfflinePlaylistStatus = 'none' | 'partial' | 'downloading' | 'all';

export interface OfflinePlaylistControl {
  status: OfflinePlaylistStatus;
  downloaded: number;
  total: number;
  /** Whether a track of this list is stored for offline play (downloaded on purpose or kept after being played). */
  isAvailable: (fileId: string) => boolean;
  /** Starts downloading what isn't stored; if everything already is, removes it all. */
  toggle: () => void;
}

/** What "make this playlist available offline" should show and do, for a list of track ids. */
export function offlinePlaylistControl(offline: UseOfflineResult, fileIds: string[]): OfflinePlaylistControl {
  const unique = [...new Set(fileIds)];
  const downloaded = unique.filter((id) => offline.isAvailable(id)).length;
  // Only what the person asked for counts: a track kept quietly because it was played isn't a download in progress.
  const working = offline.state.requestedCount > 0;
  // Tracks kept only because they were played aren't "made available" by the person: they can be evicted.
  const allPinned = unique.every((id) => offline.isPinned(id));
  const status: OfflinePlaylistStatus = unique.length > 0 && downloaded === unique.length ? 'all' : working && downloaded < unique.length ? 'downloading' : downloaded > 0 ? 'partial' : 'none';
  return {
    status,
    downloaded,
    total: unique.length,
    isAvailable: (fileId) => offline.isAvailable(fileId),
    toggle: () => {
      // Everything is stored: remove it, unless some of it is only a play-cache copy, which this keeps for good instead.
      if (status === 'all' && allPinned) offline.removeTracks(unique);
      else offline.downloadTracks(unique);
    },
  };
}

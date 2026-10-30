import { continuePlayback, type LibraryStore, type RemotePlayback, type ServerMode } from '@bpmix/core';
import { useCallback, useEffect, useState } from 'react';
import { useAppDispatch } from '../store/hooks';

export interface ContinueItem {
  remote: RemotePlayback;
  /** What it was playing, for the card ("Tike Tike Kardi - Arash"). */
  title: string;
}

export interface UseContinueElsewhereResult {
  items: ContinueItem[];
  /** Starts that device's track and position here. Resolves false (and sets `error`) when it isn't in this device's library yet. */
  continueOn: (item: ContinueItem) => Promise<boolean>;
  error: string | null;
}

const fileName = (fileId: string) => (fileId.split('/').pop() ?? fileId).replace(/\.[^.]+$/, '');

/**
 * What the person's other devices were playing, as last synced, so this one can offer to pick it up.
 * Re-read after every sync (`syncedAtMs` changes); the states themselves arrive with the sync, so this
 * never touches the network. Hidden for what this device is already playing.
 */
export function useContinueElsewhere(serverMode: ServerMode | undefined, libraryStore: LibraryStore, active: boolean, syncedAtMs: number | null, currentFileId: string | null): UseContinueElsewhereResult {
  const dispatch = useAppDispatch();
  const [items, setItems] = useState<ContinueItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverMode || !active) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const remotes = await serverMode.otherDevicesPlayback();
      const resolved = await Promise.all(
        remotes.map(async (remote): Promise<ContinueItem> => {
          const metadata = await libraryStore.getMetadata(remote.currentTrackFileId);
          const title = metadata?.title ? [metadata.title, metadata.artists.join(', ')].filter(Boolean).join(' - ') : fileName(remote.currentTrackFileId);
          return { remote, title };
        }),
      );
      if (!cancelled) setItems(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [serverMode, libraryStore, active, syncedAtMs]);

  const continueOn = useCallback(
    async (item: ContinueItem) => {
      setError(null);
      const started = await dispatch(continuePlayback(item.remote));
      if (!started) setError('That playlist or track is not on this device yet - sync, then try again.');
      return started;
    },
    [dispatch],
  );

  return { items: items.filter((item) => item.remote.currentTrackFileId !== currentFileId), continueOn, error };
}

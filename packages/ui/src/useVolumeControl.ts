import type { LibraryStore, PlaybackState, PlaylistPlayer } from '@bpmix/core';
import { useCallback, useEffect, useState } from 'react';
import { RAPID_PLAYBACK_PATCH_DEBOUNCE_MS } from './usePlaybackPersistence';

export interface VolumeControlInput {
  playlistPlayer: PlaylistPlayer;
  libraryStore: LibraryStore;
  persistPlaybackPatch: (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => void;
}

export interface VolumeControl {
  volume: number;
  handleVolumeChange: (value: number) => void;
}

/**
 * Shared volume control - identical between apps/mobile/App.tsx and
 * apps/web/src/App.tsx before this extraction. Debounced persistence
 * matters here specifically because VolumeSlider calls handleVolumeChange
 * on every drag touch-move tick (deliberately, so the audible volume
 * itself has no lag), and hitting the store that often was visibly
 * janking the drag itself.
 */
export function useVolumeControl(input: VolumeControlInput): VolumeControl {
  const { playlistPlayer, libraryStore, persistPlaybackPatch } = input;

  const [volume, setVolumeState] = useState(() => playlistPlayer.getVolume());
  useEffect(() => {
    libraryStore.getPlaybackState().then((stored) => {
      if (stored) {
        playlistPlayer.setVolume(stored.volume);
        setVolumeState(stored.volume);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVolumeChange = useCallback(
    (value: number) => {
      playlistPlayer.setVolume(value);
      setVolumeState(value);
      // Persisted so the next launch doesn't blast out at whatever volume
      // happened to be in effect before it's set once - merges onto the rest
      // of playbackStateRef rather than clobbering it back to defaults.
      persistPlaybackPatch({ volume: value }, { debounceMs: RAPID_PLAYBACK_PATCH_DEBOUNCE_MS });
    },
    // playlistPlayer is a stable ref-backed instance - omitted to match the
    // pre-extraction deps array exactly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persistPlaybackPatch],
  );

  return { volume, handleVolumeChange };
}

import type { PlaybackState, PlaylistPlayer } from '@bpmix/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RAPID_PLAYBACK_PATCH_DEBOUNCE_MS } from '@bpmix/core';

export interface VolumeControlInput {
  playlistPlayer: PlaylistPlayer;
  persistPlaybackPatch: (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => void;
  /**
   * usePlaybackPersistence's own `isRestoring` - its restore effect is the
   * sole writer of the real persisted volume onto playlistPlayer (via its
   * own setVolume(stored.volume) call, applied as early as possible in
   * restore - see that effect's own doc), and only flips isRestoring false
   * once that write has already landed. This hook used to independently
   * re-fetch libraryStore.getPlaybackState() and call setVolume itself, a
   * second, uncoordinated write racing the first - two separate async
   * writes landing at different moments produced an audible loud-then-
   * quiet-then-normal fluctuation at playback start, confirmed live. Now
   * this hook only ever READS playlistPlayer's volume back out for display
   * once restore is done, never writes it itself.
   */
  isRestoring: boolean;
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
  const { playlistPlayer, persistPlaybackPatch, isRestoring } = input;

  const [volume, setVolumeState] = useState(() => playlistPlayer.getVolume());
  // Fires once, exactly on the isRestoring true->false transition (not on
  // every render while it's already false) - see isRestoring's own doc for
  // why that moment, specifically, is when playlistPlayer's volume field
  // first reflects the real persisted value rather than TrackPlayer's
  // hardcoded masterVolume default.
  const wasRestoringRef = useRef(isRestoring);
  useEffect(() => {
    if (wasRestoringRef.current && !isRestoring) setVolumeState(playlistPlayer.getVolume());
    wasRestoringRef.current = isRestoring;
  }, [isRestoring, playlistPlayer]);

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

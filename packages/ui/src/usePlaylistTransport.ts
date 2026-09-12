import type { LoopMode, PlaybackState, PlaylistPlayer, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import { useCallback } from 'react';
import { useDoublePressHandler } from './useDoublePressHandler';

const LOOP_MODE_CYCLE: LoopMode[] = ['off', 'all', 'one'];

export interface PlaylistTransportInput {
  playlistPlayer: PlaylistPlayer;
  playerState: PlaylistPlayerState;
  persistPlaybackPatch: (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => void;
  /** Caller-owned throttle guard (see usePlaylistTransport's own doc for why this stays outside the hook). */
  transportActionAllowed: () => boolean;
  setPlayerState: (state: PlaylistPlayerState) => void;
  setError: (err: string | null) => void;
  /** Updates the module-level activeTracksById each App.tsx keeps for synchronous lookup (see e.g. its use in useCoverArt callers) - playFromTrack is the one transport action that swaps in a whole new tracksById map. */
  setActiveTracksById: (tracksById: Map<string, TrackRecord>) => void;
}

export interface PlaylistTransport {
  playFromTrack: (playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>, track: TrackRecord) => Promise<void>;
  togglePause: () => void;
  seekTo: (positionSeconds: number) => void;
  goNext: (options?: { force?: boolean }) => Promise<void>;
  goPrevious: (options?: { force?: boolean }) => Promise<void>;
  handleNextPress: () => void;
  handlePreviousPress: () => void;
  cycleLoopMode: () => void;
  toggleShuffle: () => void;
}

/**
 * Shared playlist transport actions - identical between apps/mobile/App.tsx
 * and apps/web/src/App.tsx before this extraction. `transportActionAllowed`
 * is passed in rather than reimplemented here: it closes over a
 * module-level notifyUserTookOver() bridge and a platform-specific
 * TRANSPORT_THROTTLE_MS (a react-native-audio-api-crash-avoidance value
 * that may differ per platform), so that throttle *policy* stays outside
 * shared code even though this hook consumes its result.
 */
export function usePlaylistTransport(input: PlaylistTransportInput): PlaylistTransport {
  const { playlistPlayer, playerState, persistPlaybackPatch, transportActionAllowed, setPlayerState, setError, setActiveTracksById } = input;

  const playFromTrack = useCallback(
    async (playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>, track: TrackRecord) => {
      if (!transportActionAllowed()) return;
      setError(null);
      setActiveTracksById(tracksById);
      // Tapping the already-current track just resumes it - re-running
      // setPlaylist() (a full reload/redecode) on every repeat tap was both
      // wasteful and, under rapid repeated taps, one of the ways we
      // triggered the native crash the playToken guard now defends against.
      const isSameTrack = playlistPlayer.getState().currentFileId === track.fileId;
      if (isSameTrack) {
        playlistPlayer.play();
      } else {
        // setPlaylist() sets the new position/loading status synchronously
        // before its first await (decoding the file) - grabbing state right
        // after calling it, rather than only once the whole decode resolves,
        // is what makes the row highlight and "now playing" bar appear the
        // instant you tap instead of waiting out the full decode.
        const setPlaylistPromise = playlistPlayer.setPlaylist(playlist.trackFileIds, track.fileId, { playlistId: playlist.id });
        setPlayerState(playlistPlayer.getState());
        await setPlaylistPromise;
      }
      setPlayerState(playlistPlayer.getState());
      persistPlaybackPatch({
        playlistId: playlist.id,
        currentTrackFileId: track.fileId,
        rootId: playlist.rootId,
        ...(isSameTrack ? {} : { positionSeconds: 0 }),
      });
    },
    // playlistPlayer/transportActionAllowed/setError/setPlayerState are all
    // stable across renders (a ref-backed instance, a plain closure over a
    // ref, and React state setters respectively) - omitted here to match
    // the pre-extraction deps arrays exactly and avoid recreating these
    // callbacks (and so e.g. useDoublePressHandler's memoized handlers)
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persistPlaybackPatch, setActiveTracksById],
  );

  const togglePause = useCallback(() => {
    if (!transportActionAllowed()) return;
    // isAudible (not raw status) - a new track can be decoding in the
    // background (status 'loading') while the previous one is still
    // genuinely playing (see TrackPlayerState.isAudible's doc), and this
    // should still pause that instead of falling through to play() just
    // because status itself isn't literally 'playing' right now.
    if (playerState.track.isAudible) {
      playlistPlayer.pause();
      // Captures the exact stop point immediately rather than waiting on the
      // next throttled poll-tick persist, which no longer fires once paused.
      persistPlaybackPatch({ positionSeconds: playlistPlayer.getState().track.positionSeconds });
    } else {
      playlistPlayer.play();
    }
    setPlayerState(playlistPlayer.getState());
    // See playFromTrack's comment above for why playlistPlayer/
    // transportActionAllowed/setPlayerState are omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerState.track.isAudible, persistPlaybackPatch]);

  const seekTo = useCallback(
    (positionSeconds: number) => {
      if (!transportActionAllowed()) return;
      playlistPlayer.seek(positionSeconds);
      setPlayerState(playlistPlayer.getState());
      persistPlaybackPatch({ positionSeconds: playlistPlayer.getState().track.positionSeconds });
    },
    // See playFromTrack's comment above for why playlistPlayer/
    // transportActionAllowed/setPlayerState are omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persistPlaybackPatch],
  );

  const goNext = useCallback(
    async (options?: { force?: boolean }) => {
      if (!transportActionAllowed()) return;
      // next()/previous() set the new position/loading status synchronously
      // before their first await (decoding the file) - same reasoning as
      // playFromTrack's identical pattern above: grabbing state right after
      // calling it, rather than only once the whole decode resolves, is what
      // makes the tap register instantly (title/art/loading-bar all update
      // right away) instead of the UI sitting frozen for the whole decode.
      const nextPromise = playlistPlayer.next(options);
      setPlayerState(playlistPlayer.getState());
      await nextPromise;
      const state = playlistPlayer.getState();
      setPlayerState(state);
      if (state.currentFileId) {
        persistPlaybackPatch({ currentTrackFileId: state.currentFileId, positionSeconds: state.track.positionSeconds });
      }
    },
    // See playFromTrack's comment above for why playlistPlayer/
    // transportActionAllowed/setPlayerState are omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persistPlaybackPatch],
  );

  const goPrevious = useCallback(
    async (options?: { force?: boolean }) => {
      if (!transportActionAllowed()) return;
      // See goNext's identical comment above.
      const previousPromise = playlistPlayer.previous(options);
      setPlayerState(playlistPlayer.getState());
      await previousPromise;
      const state = playlistPlayer.getState();
      setPlayerState(state);
      if (state.currentFileId) {
        persistPlaybackPatch({ currentTrackFileId: state.currentFileId, positionSeconds: state.track.positionSeconds });
      }
    },
    // See playFromTrack's comment above for why playlistPlayer/
    // transportActionAllowed/setPlayerState are omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persistPlaybackPatch],
  );

  // Single tap respects loop mode (restart-current on "One", wrap on "All",
  // clamp on "Off"); double tap always moves tracks, wrapping regardless of
  // loop mode - see PlaylistPlayer.next/previous's { force } option.
  const handleNextPress = useDoublePressHandler(
    () => void goNext(),
    () => void goNext({ force: true }),
  );
  const handlePreviousPress = useDoublePressHandler(
    () => void goPrevious(),
    () => void goPrevious({ force: true }),
  );

  const cycleLoopMode = useCallback(() => {
    const nextMode = LOOP_MODE_CYCLE[(LOOP_MODE_CYCLE.indexOf(playerState.loopMode) + 1) % LOOP_MODE_CYCLE.length]!;
    playlistPlayer.setLoopMode(nextMode);
    setPlayerState(playlistPlayer.getState());
    persistPlaybackPatch({ loopMode: nextMode });
    // See playFromTrack's comment above for why playlistPlayer/setPlayerState are omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerState.loopMode, persistPlaybackPatch]);

  const toggleShuffle = useCallback(() => {
    const nextEnabled = !playerState.shuffleEnabled;
    playlistPlayer.setShuffle(nextEnabled);
    setPlayerState(playlistPlayer.getState());
    persistPlaybackPatch({ shuffleEnabled: nextEnabled, shuffleOrder: playlistPlayer.getShuffleOrder() });
    // See playFromTrack's comment above for why playlistPlayer/setPlayerState are omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerState.shuffleEnabled, persistPlaybackPatch]);

  return {
    playFromTrack,
    togglePause,
    seekTo,
    goNext,
    goPrevious,
    handleNextPress,
    handlePreviousPress,
    cycleLoopMode,
    toggleShuffle,
  };
}

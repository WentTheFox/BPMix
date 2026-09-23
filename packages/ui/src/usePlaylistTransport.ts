import type { LoopMode, PlaybackState, PlaylistPlayer, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import { useCallback, useRef } from 'react';
import { useDoublePressHandler } from './useDoublePressHandler';

const LOOP_MODE_CYCLE: LoopMode[] = ['off', 'all', 'one'];

/**
 * Upper bound on how many consecutive already-known-missing tracks goNext/
 * goPrevious will silently skip past in one call - a real (if pathological)
 * playlist could be entirely unavailable (e.g. its whole root just dropped
 * out via a network mount), and this stops that from becoming an unbounded
 * synchronous chain of playlistPlayer.next()/previous() calls.
 */
const MAX_CONSECUTIVE_MISSING_SKIPS = 50;

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
  /**
   * True for a track already known this session to be unreachable - a
   * persisted TrackRecord.missing (an unresolved playlist entry, known since
   * the last scan) or one that failed a live decode attempt just now (see
   * App.tsx's missingFileIds/reportError). goNext/goPrevious use this to
   * keep advancing straight past such a track instead of running (and
   * failing) a real decode attempt on it - without this, rapidly skipping
   * through a stretch of already-known-bad tracks (e.g. a sync-in-progress
   * folder) ran a full doomed decode attempt per track, each one flashing
   * the loading spinner before failing the same way it already had.
   * Re-checked fresh on every call (via a ref, not a dep array) since the
   * set of known-missing fileIds changes over the session.
   */
  isTrackMissing: (fileId: string) => boolean;
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
  const { playlistPlayer, playerState, persistPlaybackPatch, transportActionAllowed, setPlayerState, setError, setActiveTracksById, isTrackMissing } = input;
  // A ref, not a dep on goNext/goPrevious's useCallback, since isTrackMissing
  // closes over App.tsx's missingFileIds state (changes over the session)
  // while those callbacks intentionally keep a narrow dep array (see their
  // own comments) - reading through a ref keeps this check always current
  // without recreating (and so losing referential stability of) the callback
  // itself every time missingFileIds changes.
  const isTrackMissingRef = useRef(isTrackMissing);
  isTrackMissingRef.current = isTrackMissing;

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
      //
      // The loop below is one logical user action (a single tap or double-
      // tap), not repeated ones - transportActionAllowed()/
      // notifyUserTookOver() only run once, above, not per skip iteration.
      let state = playlistPlayer.getState();
      for (let skipped = 0; skipped <= MAX_CONSECUTIVE_MISSING_SKIPS; skipped++) {
        const nextPromise = playlistPlayer.next(options);
        setPlayerState(playlistPlayer.getState());
        await nextPromise;
        state = playlistPlayer.getState();
        setPlayerState(state);
        if (!state.currentFileId || !isTrackMissingRef.current(state.currentFileId)) break;
      }
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
      let state = playlistPlayer.getState();
      for (let skipped = 0; skipped <= MAX_CONSECUTIVE_MISSING_SKIPS; skipped++) {
        const previousPromise = playlistPlayer.previous(options);
        setPlayerState(playlistPlayer.getState());
        await previousPromise;
        state = playlistPlayer.getState();
        setPlayerState(state);
        if (!state.currentFileId || !isTrackMissingRef.current(state.currentFileId)) break;
      }
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

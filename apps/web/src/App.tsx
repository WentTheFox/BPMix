import type {
  FileRef,
  GrantedRoot,
  LoopMode,
  PlaybackState,
  PlaylistPlayerState,
  PlaylistRecord,
  TrackRecord,
} from '@bpmix/core';
import {
  computeTransitionPlan,
  ensureTrackAnalyzed,
  equalPowerGain,
  formatTrackTitle,
  isMetadataCurrent,
  PlaylistPlayer,
  realTimeForOutgoingPosition,
  scanLibraryMetadata,
  scanRoot,
} from '@bpmix/core';
import {
  CrossfadeArt,
  Icon,
  IconLabel,
  SeekBar,
  TrackList,
  useCoverArt,
  useDoublePressHandler,
  useTrackAnalysis,
  useTrackMetadata,
  VolumeSlider,
} from '@bpmix/ui';
import {
  mdiArrowLeft,
  mdiFastForward10,
  mdiFolder,
  mdiFolderPlus,
  mdiMusicNote,
  mdiPause,
  mdiPlay,
  mdiPlaylistMusic,
  mdiRefresh,
  mdiRewind10,
  mdiSkipNext,
  mdiSkipPrevious,
} from '@mdi/js';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DimensionValue } from 'react-native';
import { FlatList, Image, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { createAudioEngine } from './adapters/audioEngine';
import { createCoverArtResizer } from './adapters/coverArtResizer';
import { createFileAccess } from './adapters/fileAccess';
import { createLibraryStore } from './adapters/libraryStore';

const TRANSPORT_THROTTLE_MS = 300;
// How often to persist positionSeconds while a track is playing - frequent
// enough that a crash/tab-close loses very little progress, infrequent
// enough not to hammer IndexedDB on every ~200ms poll tick.
const POSITION_PERSIST_INTERVAL_MS = 5000;
// A real settings screen (Stage 8) would persist this - for now it's a
// simple in-memory control (see the "Crossfade" stepper below) that starts
// here and can be adjusted live.
const DEFAULT_CROSSFADE_SECONDS = 8;
const MIN_CROSSFADE_SECONDS = 1;
const MAX_CROSSFADE_SECONDS = 20;

const fileAccess = createFileAccess();
const libraryStore = createLibraryStore();
const coverArtResizer = createCoverArtResizer();
const audioEngine = createAudioEngine(fileAccess);

function trackToFileRef(track: TrackRecord): FileRef {
  return {
    id: track.fileId,
    name: track.relativePath.split('/').pop() ?? track.relativePath,
    relativePath: track.relativePath,
    sizeBytes: track.sizeBytes,
    lastModifiedMs: track.lastModifiedMs,
  };
}

// PlaylistPlayer resolves a fileId to a FileRef via this module-level map,
// kept pointed at whichever playlist screen is currently open (there's only
// ever one active player/screen in this app). setError is likewise bridged
// in on mount so the player's async load/decode errors reach the UI.
let activeTracksById = new Map<string, TrackRecord>();
let reportError: (error: unknown) => void = () => {};
// Bridged in on mount, same pattern as reportError - lets PlaylistPlayer push
// an immediate re-render right when position changes outside a manual UI
// action (a crossfade completing, or a natural end auto-advancing), instead
// of the "now playing" display waiting on the next ~200ms poll tick to
// notice (see PlaylistPlayer's onAdvance doc).
let notifyAdvance: () => void = () => {};

const playlistPlayer = new PlaylistPlayer(
  audioEngine,
  (fileId) => {
    const track = activeTracksById.get(fileId);
    if (!track) throw new Error(`Unknown track ${fileId}`);
    return trackToFileRef(track);
  },
  {
    onError: (error) => reportError(error),
    resolveGain: async (fileId) => (await libraryStore.getAnalysis(fileId))?.normalizationGain ?? 1,
    onAdvance: () => notifyAdvance(),
    crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
    // Just-in-time analysis (Stage 4): a track already needed a decode for
    // playback/preload, so analyzing it here is free - no separate eager
    // batch pass over the whole library.
    onDecoded: (ref, decoded) => {
      void ensureTrackAnalyzed(libraryStore, ref, decoded);
    },
  },
);

// playlistPlayer/audioEngine are module-level singletons, but the browser's
// AudioContext they wrap isn't torn down just because a Vite HMR reload
// discards this module's JS references to it - without this, a track would
// keep playing (audibly) straight through every reload, orphaned from the
// fresh instances the reloaded module creates.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    playlistPlayer.pause();
  });
}

const LOOP_MODE_CYCLE: LoopMode[] = ['off', 'all', 'one'];
const LOOP_MODE_LABEL: Record<LoopMode, string> = { off: 'Loop: Off', all: 'Loop: All', one: 'Loop: One' };

interface RootWithLibrary {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
  tracksById: Map<string, TrackRecord>;
}

type Screen =
  | { kind: 'library' }
  | { kind: 'playlist'; root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const lightColors = {
  background: '#ffffff',
  text: '#111111',
  subtleText: '#111111',
};

const darkColors = {
  background: '#111111',
  text: '#f5f5f5',
  subtleText: '#f5f5f5',
};
type Colors = typeof lightColors;

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const colors = isDarkMode ? darkColors : lightColors;
  const [rootsWithLibrary, setRootsWithLibrary] = useState<RootWithLibrary[]>([]);
  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  const [playerState, setPlayerState] = useState<PlaylistPlayerState>(playlistPlayer.getState());

  // Shared cooldown across every action that creates/destroys a native audio
  // source (seek, pause/resume, re-playing a track): a known bug in
  // react-native-audio-api's Android native cleanup code can crash the app
  // under rapid-fire source churn. This doesn't fix that bug, but keeps
  // normal human-paced usage well clear of the trigger.
  const lastTransportActionAtRef = useRef(0);
  const transportActionAllowed = (): boolean => {
    const now = Date.now();
    if (now - lastTransportActionAtRef.current < TRANSPORT_THROTTLE_MS) {
      return false;
    }
    lastTransportActionAtRef.current = now;
    return true;
  };

  // Last known playback state, kept in sync with what's actually persisted -
  // lets every call site merge its own change onto the rest without an
  // async getPlaybackState() round trip first (and without a stale closure
  // clobbering a concurrent change, since this is a ref, not state).
  const playbackStateRef = useRef<PlaybackState>({
    playlistId: null,
    currentTrackFileId: null,
    positionSeconds: 0,
    loopMode: 'off',
    shuffleEnabled: false,
    volume: 1,
  });
  const persistPlaybackPatch = useCallback((patch: Partial<PlaybackState>) => {
    playbackStateRef.current = { ...playbackStateRef.current, ...patch };
    void libraryStore.putPlaybackState(playbackStateRef.current);
  }, []);
  const lastPositionPersistAtRef = useRef(0);

  useEffect(() => {
    reportError = (err) => setError(String(err));
    return () => {
      reportError = () => {};
    };
  }, []);

  useEffect(() => {
    notifyAdvance = () => {
      const state = playlistPlayer.getState();
      setPlayerState(state);
      // Covers every advance not already handled at its own call site: a
      // crossfade completing and a track ending naturally both change
      // currentFileId without going through goNext/goPrevious.
      if (state.currentFileId) {
        persistPlaybackPatch({ currentTrackFileId: state.currentFileId, positionSeconds: state.track.positionSeconds });
      }
    };
    return () => {
      notifyAdvance = () => {};
    };
  }, [persistPlaybackPatch]);

  const refresh = useCallback(async () => {
    const roots = await fileAccess.listGrantedRoots();
    const withLibrary = await Promise.all(
      roots.map(async (root) => {
        const [playlists, tracks] = await Promise.all([
          libraryStore.listPlaylists(root.id),
          libraryStore.listTracks(root.id),
        ]);
        return { root, playlists, tracksById: new Map(tracks.map((t) => [t.fileId, t])) };
      }),
    );
    setRootsWithLibrary(withLibrary);
    // Fire-and-forget: fills in real titles/artists as it goes (each row's
    // useTrackMetadata retry-polls the store), rather than blocking the
    // library screen on reading every file's tag bytes up front. Cheap to
    // call again on every refresh - already-fresh tracks are skipped
    // without a re-read (see scanLibraryMetadata/isMetadataFresh).
    void scanLibraryMetadata(fileAccess, libraryStore, withLibrary.flatMap(({ tracksById }) => [...tracksById.values()]), {
      resizer: coverArtResizer,
    });
    return withLibrary;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const withLibrary = await refresh();
      const stored = await libraryStore.getPlaybackState();
      if (cancelled || !stored) return;
      playbackStateRef.current = stored;
      if (!stored.playlistId || !stored.currentTrackFileId) return;
      for (const { root, playlists, tracksById } of withLibrary) {
        const playlist = playlists.find((p) => p.id === stored.playlistId);
        if (!playlist || !playlist.trackFileIds.includes(stored.currentTrackFileId)) continue;
        activeTracksById = tracksById;
        playlistPlayer.setShuffle(stored.shuffleEnabled);
        playlistPlayer.setLoopMode(stored.loopMode);
        // setPlaylist() decodes and calls play() internally - harmless here
        // since the browser's autoplay policy leaves the AudioContext
        // suspended (no audible sound) until a real user gesture resumes
        // it, but this still loads the right track/position instead of
        // leaving the player empty. pause() immediately after puts the UI
        // in the expected "loaded, not playing" state on a fresh launch.
        await playlistPlayer.setPlaylist(playlist.trackFileIds, stored.currentTrackFileId);
        if (cancelled) return;
        playlistPlayer.pause();
        if (stored.positionSeconds > 0) playlistPlayer.seek(stored.positionSeconds);
        setPlayerState(playlistPlayer.getState());
        setScreen({ kind: 'playlist', root, playlist, tracksById });
        break;
      }
    })().catch((err) => setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      const state = playlistPlayer.getState();
      setPlayerState(state);
      playlistPlayer.checkPreload(); // Stage 6 lookahead - reuses this poll instead of a second timer
      const now = Date.now();
      if (
        state.currentFileId &&
        (state.track.status === 'playing' || state.track.status === 'paused') &&
        now - lastPositionPersistAtRef.current >= POSITION_PERSIST_INTERVAL_MS
      ) {
        lastPositionPersistAtRef.current = now;
        persistPlaybackPatch({ positionSeconds: state.track.positionSeconds });
      }
    }, 200);
    return () => clearInterval(interval);
  }, [persistPlaybackPatch]);

  const addFolder = useCallback(async () => {
    setError(null);
    try {
      const root = await fileAccess.requestRoot();
      if (!root) return; // user cancelled the picker
      setBusyRootId(root.id);
      await scanRoot(fileAccess, libraryStore, root.id);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyRootId(null);
    }
  }, [refresh]);

  const rescan = useCallback(
    async (rootId: string) => {
      setError(null);
      setBusyRootId(rootId);
      try {
        await scanRoot(fileAccess, libraryStore, rootId);
        await refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusyRootId(null);
      }
    },
    [refresh],
  );

  const playFromTrack = useCallback(
    async (playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>, track: TrackRecord) => {
      if (!transportActionAllowed()) return;
      setError(null);
      activeTracksById = tracksById;
      // Tapping the already-current track just resumes it - re-running
      // setPlaylist() (a full reload/redecode) on every repeat tap was both
      // wasteful and, under rapid repeated taps, one of the ways we
      // triggered the native crash the playToken guard now defends against.
      const isSameTrack = playlistPlayer.getState().currentFileId === track.fileId;
      if (isSameTrack) {
        playlistPlayer.play();
      } else {
        await playlistPlayer.setPlaylist(playlist.trackFileIds, track.fileId);
      }
      setPlayerState(playlistPlayer.getState());
      persistPlaybackPatch({
        playlistId: playlist.id,
        currentTrackFileId: track.fileId,
        ...(isSameTrack ? {} : { positionSeconds: 0 }),
      });
    },
    [persistPlaybackPatch],
  );

  const togglePause = useCallback(() => {
    if (!transportActionAllowed()) return;
    if (playerState.track.status === 'playing') {
      playlistPlayer.pause();
      // Captures the exact stop point immediately rather than waiting on the
      // next throttled poll-tick persist, which no longer fires once paused.
      persistPlaybackPatch({ positionSeconds: playlistPlayer.getState().track.positionSeconds });
    } else {
      playlistPlayer.play();
    }
    setPlayerState(playlistPlayer.getState());
  }, [playerState.track.status, persistPlaybackPatch]);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      if (!transportActionAllowed()) return;
      playlistPlayer.seek(playerState.track.positionSeconds + deltaSeconds);
      setPlayerState(playlistPlayer.getState());
      persistPlaybackPatch({ positionSeconds: playlistPlayer.getState().track.positionSeconds });
    },
    [playerState.track.positionSeconds, persistPlaybackPatch],
  );

  const seekTo = useCallback(
    (positionSeconds: number) => {
      if (!transportActionAllowed()) return;
      playlistPlayer.seek(positionSeconds);
      setPlayerState(playlistPlayer.getState());
      persistPlaybackPatch({ positionSeconds: playlistPlayer.getState().track.positionSeconds });
    },
    [persistPlaybackPatch],
  );

  const goNext = useCallback(async (options?: { force?: boolean }) => {
    if (!transportActionAllowed()) return;
    await playlistPlayer.next(options);
    const state = playlistPlayer.getState();
    setPlayerState(state);
    if (state.currentFileId) {
      persistPlaybackPatch({ currentTrackFileId: state.currentFileId, positionSeconds: state.track.positionSeconds });
    }
  }, [persistPlaybackPatch]);

  const goPrevious = useCallback(async (options?: { force?: boolean }) => {
    if (!transportActionAllowed()) return;
    await playlistPlayer.previous(options);
    const state = playlistPlayer.getState();
    setPlayerState(state);
    if (state.currentFileId) {
      persistPlaybackPatch({ currentTrackFileId: state.currentFileId, positionSeconds: state.track.positionSeconds });
    }
  }, [persistPlaybackPatch]);

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
  }, [playerState.loopMode, persistPlaybackPatch]);

  const toggleShuffle = useCallback(() => {
    const nextEnabled = !playerState.shuffleEnabled;
    playlistPlayer.setShuffle(nextEnabled);
    setPlayerState(playlistPlayer.getState());
    persistPlaybackPatch({ shuffleEnabled: nextEnabled });
  }, [playerState.shuffleEnabled, persistPlaybackPatch]);

  const [volume, setVolumeState] = useState(() => playlistPlayer.getVolume());
  useEffect(() => {
    libraryStore.getPlaybackState().then((stored) => {
      if (stored) {
        playlistPlayer.setVolume(stored.volume);
        setVolumeState(stored.volume);
      }
    });
  }, []);
  const handleVolumeChange = useCallback(
    (value: number) => {
      playlistPlayer.setVolume(value);
      setVolumeState(value);
      // Persisted so the next launch doesn't blast out at whatever volume
      // happened to be in effect before it's set once - merges onto the rest
      // of playbackStateRef rather than clobbering it back to defaults.
      persistPlaybackPatch({ volume: value });
    },
    [persistPlaybackPatch],
  );

  const nowPlayingTrack = playerState.currentFileId ? activeTracksById.get(playerState.currentFileId) : undefined;

  // Debug view (Stage 4 exit criterion): shows the currently playing
  // track's computed BPM/gain, proving analysis actually ran and produced
  // real numbers, not just that it didn't crash.
  const currentAnalysis = useTrackAnalysis(libraryStore, playerState.currentFileId);

  // Debug view: preview of the crossfade into whatever's queued up next,
  // computed from the same TransitionPlan/visualization data real playback
  // scheduling will use - lets the fade timing be checked by eye before
  // (and regardless of) actual audio engine wiring. No BPM/analysis lookup
  // needed for this plan any more - see computeTransitionPlan's doc; the
  // preview's bpm labels just read "BPM unknown" for now (live BPM display
  // is a later round).
  const [nextFileId, setNextFileId] = useState<string | null>(null);
  useEffect(() => {
    setNextFileId(playlistPlayer.getNextFileId());
  }, [playerState.position, playerState.loopMode, playerState.shuffleEnabled, playerState.totalTracks]);
  const nextTrack = nextFileId ? activeTracksById.get(nextFileId) : undefined;

  // Live-adjustable crossfade duration (the "Crossfade" stepper below) -
  // keeps playlistPlayer's actual scheduling in sync with whatever the
  // preview is showing, so they never disagree.
  const [crossfadeSeconds, setCrossfadeSecondsState] = useState(DEFAULT_CROSSFADE_SECONDS);
  useEffect(() => {
    playlistPlayer.setCrossfadeSeconds(crossfadeSeconds);
  }, [crossfadeSeconds]);
  const adjustCrossfadeSeconds = useCallback((delta: number) => {
    setCrossfadeSecondsState((current) =>
      Math.max(MIN_CROSSFADE_SECONDS, Math.min(MAX_CROSSFADE_SECONDS, current + delta)),
    );
  }, []);

  // A crossfade already in flight (natural end-of-track OR a manual skip's
  // short one - see TrackPlayerState.pendingIncoming's doc) switches the
  // displayed name/position/duration/track-counter over to the incoming
  // track immediately, rather than waiting for onCrossfadeCompleted - lines
  // the display change up with what's already audible throughout the fade,
  // instead of an abrupt seek-bar jump the instant the swap actually
  // completes (the bar climbing toward the OUTGOING track's duration for
  // the whole fade, then snapping to a small fraction of the usually much
  // longer incoming track's duration).
  const pendingIncoming = playerState.track.pendingIncoming;
  // Explicit rather than inferred from currentFileId/nextFileId - see
  // PlaylistPlayerState.pendingCrossfadeFileIds' doc for why those two
  // don't reliably mean "outgoing"/"incoming" on their own (a manual skip
  // advances position/currentFileId to the target immediately, unlike the
  // natural end-of-track crossfade, which only does that once it completes).
  const pendingCrossfadeFileIds = playerState.pendingCrossfadeFileIds;
  const pendingOutgoingTrack = pendingCrossfadeFileIds ? activeTracksById.get(pendingCrossfadeFileIds.outgoing) : undefined;
  const pendingIncomingTrack = pendingCrossfadeFileIds ? activeTracksById.get(pendingCrossfadeFileIds.incoming) : undefined;
  // True only for a manual skip (crossfadeToPosition already advanced
  // currentFileId to the incoming target); false for the natural
  // end-of-track path (currentFileId is still the outgoing side throughout).
  const isManualSkipPending = pendingCrossfadeFileIds && playerState.currentFileId === pendingCrossfadeFileIds.incoming;

  const transitionPlan = useMemo(() => {
    if (pendingIncoming) {
      // A crossfade is genuinely happening right now - reflect its real
      // duration (a manual skip's fadeDurationSeconds is much shorter than
      // the natural end-of-track crossfadeSeconds default below), not a
      // static preview of a future one.
      return { fadeStartSeconds: 0, fadeDurationSeconds: pendingIncoming.fadeDurationSeconds, incomingStartSeconds: 0 };
    }
    if (playerState.track.durationSeconds <= 0) return null;
    return computeTransitionPlan(playerState.track.durationSeconds, crossfadeSeconds);
  }, [pendingIncoming, playerState.track.durationSeconds, crossfadeSeconds]);

  // The preview's timeline is relative to the fade start (t=0). While a
  // crossfade is actually in flight, pendingIncoming.positionSeconds IS
  // that elapsed time directly (incomingStartSeconds is always 0, rate is
  // always 1 this round) - no need for realTimeForOutgoingPosition's
  // fadeStartSeconds-relative math, which only applies to the *preview* of
  // a future natural-end crossfade computed from the static default plan.
  const crossfadeProgressSeconds = pendingIncoming
    ? pendingIncoming.positionSeconds
    : transitionPlan
      ? realTimeForOutgoingPosition(transitionPlan, playerState.track.positionSeconds)
      : null;

  const displayTrack = pendingIncoming ? (pendingIncomingTrack ?? nowPlayingTrack) : nowPlayingTrack;
  const displayTrackMetadata = useTrackMetadata(libraryStore, displayTrack?.fileId ?? null);
  const outgoingTrack = pendingOutgoingTrack ?? nowPlayingTrack;
  const incomingTrack = pendingIncomingTrack ?? nextTrack;
  const outgoingTrackMetadata = useTrackMetadata(libraryStore, outgoingTrack?.fileId ?? null);
  const incomingTrackMetadata = useTrackMetadata(libraryStore, incomingTrack?.fileId ?? null);
  const outgoingCoverArt = useCoverArt(libraryStore, outgoingTrack?.fileId ?? null, isMetadataCurrent(outgoingTrackMetadata));
  const incomingCoverArt = useCoverArt(libraryStore, incomingTrack?.fileId ?? null, isMetadataCurrent(incomingTrackMetadata));
  // Same equalPowerGain() call SourceNode.rampGainCurve uses for the real
  // audio fade, sampled at the current progress instead of over a curve -
  // this is what makes the art dissolve at exactly the rate the audio
  // itself fades (see CrossfadeArt's doc).
  const fadeDurationSeconds = transitionPlan?.fadeDurationSeconds ?? 0;
  const crossfadeFraction =
    crossfadeProgressSeconds == null
      ? null
      : fadeDurationSeconds > 0
        ? crossfadeProgressSeconds / fadeDurationSeconds
        : crossfadeProgressSeconds >= 0
          ? 1
          : 0;
  const outgoingGain = crossfadeFraction == null ? 1 : equalPowerGain(crossfadeFraction, true, fadeDurationSeconds);
  const incomingGain = crossfadeFraction == null ? 0 : equalPowerGain(crossfadeFraction, false, fadeDurationSeconds);
  const displayPositionSeconds = pendingIncoming ? pendingIncoming.positionSeconds : playerState.track.positionSeconds;
  const displayDurationSeconds = pendingIncoming ? pendingIncoming.durationSeconds : playerState.track.durationSeconds;
  const displayTrackNumber =
    pendingIncoming && !isManualSkipPending && playerState.totalTracks > 0
      ? ((playerState.position >= playerState.totalTracks - 1 ? 0 : playerState.position + 1) % playerState.totalTracks) + 1
      : playerState.position + 1;

  const displayCoverArt = useCoverArt(libraryStore, displayTrack?.fileId ?? null, isMetadataCurrent(displayTrackMetadata));

  const nowPlayingBar = playerState.currentFileId && (
    <View style={styles.nowPlaying}>
      <View style={styles.nowPlayingHeader}>
        {displayCoverArt ? (
          <Image source={{ uri: displayCoverArt }} style={styles.nowPlayingArt} />
        ) : (
          <View style={[styles.nowPlayingArt, styles.nowPlayingArtPlaceholder]} />
        )}
        <View style={styles.nowPlayingHeaderText}>
          <Text style={[styles.nowPlayingName, { color: colors.text }]} numberOfLines={1}>
            {displayTrack ? formatTrackTitle(displayTrackMetadata, displayTrack) : playerState.currentFileId}
          </Text>
          <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
            {formatSeconds(displayPositionSeconds)} / {formatSeconds(displayDurationSeconds)} (
            {playerState.track.status}) · track {displayTrackNumber}/{playerState.totalTracks}
          </Text>
          {currentAnalysis && (
            <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
              Gain: {currentAnalysis.normalizationGain.toFixed(2)}x
            </Text>
          )}
        </View>
      </View>
      {transitionPlan && (
        <CrossfadeArt
          outgoingArtUri={outgoingCoverArt}
          incomingArtUri={incomingCoverArt}
          outgoingGain={outgoingGain}
          incomingGain={incomingGain}
        />
      )}
      <SeekBar
        positionSeconds={displayPositionSeconds}
        durationSeconds={displayDurationSeconds}
        // Disabled mid-crossfade: seekTo() still only affects the actual
        // (outgoing) source, which no longer matches what the bar is
        // showing (the incoming track's position/duration) - a tap here
        // would compute a fraction against the wrong track's duration.
        onSeekTo={pendingIncoming ? () => {} : seekTo}
      />
      <View style={styles.playerControlsRow}>
        <Pressable style={styles.controlButton} onPress={handlePreviousPress}>
          <Icon path={mdiSkipPrevious} size={20} color="white" />
        </Pressable>
        <Pressable style={styles.controlButtonWide} onPress={() => seekBy(-10)}>
          <Icon path={mdiRewind10} size={22} color="white" />
        </Pressable>
        <Pressable style={[styles.controlButton, styles.controlButtonPrimary]} onPress={togglePause}>
          <Icon path={playerState.track.status === 'playing' ? mdiPause : mdiPlay} size={30} color="white" />
        </Pressable>
        <Pressable style={styles.controlButtonWide} onPress={() => seekBy(10)}>
          <Icon path={mdiFastForward10} size={22} color="white" />
        </Pressable>
        <Pressable style={styles.controlButton} onPress={handleNextPress}>
          <Icon path={mdiSkipNext} size={20} color="white" />
        </Pressable>
      </View>
      <View style={styles.transportRow}>
        <Pressable style={styles.transportButton} onPress={cycleLoopMode}>
          <Text style={styles.transportButtonText}>{LOOP_MODE_LABEL[playerState.loopMode]}</Text>
        </Pressable>
        <Pressable style={styles.transportButton} onPress={toggleShuffle}>
          <Text style={styles.transportButtonText}>Shuffle: {playerState.shuffleEnabled ? 'On' : 'Off'}</Text>
        </Pressable>
      </View>
      <View style={styles.transportRow}>
        <Pressable
          style={styles.transportButton}
          onPress={() => adjustCrossfadeSeconds(-1)}
          disabled={crossfadeSeconds <= MIN_CROSSFADE_SECONDS}
        >
          <Text style={styles.transportButtonText}>-1s</Text>
        </Pressable>
        <Text style={[styles.transportButtonText, { color: colors.text, minWidth: 100, textAlign: 'center' }]}>
          Crossfade: {crossfadeSeconds}s
        </Text>
        <Pressable
          style={styles.transportButton}
          onPress={() => adjustCrossfadeSeconds(1)}
          disabled={crossfadeSeconds >= MAX_CROSSFADE_SECONDS}
        >
          <Text style={styles.transportButtonText}>+1s</Text>
        </Pressable>
      </View>
      <VolumeSlider volume={volume} onChangeVolume={handleVolumeChange} />
    </View>
  );

  if (screen.kind === 'playlist') {
    const { playlist, tracksById } = screen;
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Pressable onPress={() => setScreen({ kind: 'library' })} style={styles.backRow}>
          <IconLabel path={mdiArrowLeft} text={playlist.name} color={colors.text} iconSize={18} textStyle={styles.backLink} />
        </Pressable>
        {error && <Text style={styles.error}>{error}</Text>}
        {nowPlayingBar}
        <TrackList
          trackFileIds={playlist.trackFileIds}
          tracksById={tracksById}
          currentFileId={playerState.currentFileId}
          isPlaying={playerState.track.status === 'playing'}
          textColor={colors.text}
          onPressTrack={(t) => void playFromTrack(playlist, tracksById, t)}
          libraryStore={libraryStore}
          initialNumToRender={30}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <IconLabel
        path={mdiMusicNote}
        text="BPMix"
        color={colors.text}
        iconSize={28}
        textStyle={styles.title}
        containerStyle={styles.titleRow}
      />
      <Pressable style={styles.button} onPress={addFolder}>
        <IconLabel path={mdiFolderPlus} text="Add Folder" color="white" iconSize={18} textStyle={styles.buttonText} />
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
      {nowPlayingBar}

      <FlatList
        style={styles.list}
        data={rootsWithLibrary}
        keyExtractor={({ root }) => root.id}
        renderItem={({ item: { root, playlists, tracksById } }) => (
          <View style={styles.rootSection}>
            <View style={styles.rootHeader}>
              <IconLabel path={mdiFolder} text={root.displayName} color={colors.text} iconSize={18} textStyle={styles.rootName} />
              <Pressable onPress={() => rescan(root.id)} disabled={busyRootId === root.id}>
                {busyRootId === root.id ? (
                  <Text style={styles.rescanLink}>Scanning…</Text>
                ) : (
                  <IconLabel path={mdiRefresh} text="Rescan" color="#3b82f6" iconSize={16} textStyle={styles.rescanLink} />
                )}
              </Pressable>
            </View>
            {playlists.length === 0 && (
              <Text style={[styles.empty, { color: colors.subtleText }]}>No playlists found yet.</Text>
            )}
            {playlists.map((playlist) => (
              <Pressable
                key={playlist.id}
                style={styles.playlist}
                onPress={() => setScreen({ kind: 'playlist', root, playlist, tracksById })}
              >
                <IconLabel
                  path={mdiPlaylistMusic}
                  text={playlist.name}
                  color={colors.text}
                  iconSize={16}
                  textStyle={styles.playlistName}
                />
                <Text style={[styles.trackCount, { color: colors.subtleText }]}>
                  {playlist.trackFileIds.length} track(s)
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // FlatList needs a bounded-height ancestor to compute its own viewport
    // and actually virtualize - minHeight lets the page grow past 100vh and
    // never gives it one, so on web it was effectively rendering every row
    // anyway despite using FlatList.
    // react-native-web accepts CSS units like this at runtime; core RN's
    // own DimensionValue type (what resolves here) doesn't include them.
    height: '100vh' as unknown as DimensionValue,
    alignItems: 'center',
    paddingTop: 48,
  },
  titleRow: {
    marginBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  buttonText: {
    color: 'white',
    fontWeight: '600',
  },
  error: {
    color: '#dc2626',
    marginTop: 12,
    maxWidth: 480,
    textAlign: 'center',
  },
  backRow: {
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  backLink: {
    fontSize: 18,
    fontWeight: '600',
  },
  nowPlaying: {
    marginTop: 16,
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
  nowPlayingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nowPlayingHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  nowPlayingArt: {
    width: 48,
    height: 48,
    borderRadius: 6,
  },
  nowPlayingArtPlaceholder: {
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  nowPlayingName: {
    fontSize: 15,
    fontWeight: '600',
  },
  nowPlayingTime: {
    fontSize: 12,
    marginTop: 2,
  },
  transportRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  transportButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  transportButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 12,
  },
  // The primary play/pause/seek/skip row, styled like a real player's
  // transport bar: big circular icon buttons, evenly spaced, with
  // play/pause noticeably larger and centered - easier to tap accurately
  // on mobile than the small text-label buttons every other row still uses.
  playerControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  controlButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonWide: {
    width: 60,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonPrimary: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#2563eb',
  },
  list: {
    flex: 1,
    marginTop: 24,
    width: '100%',
    maxWidth: 480,
  },
  rootSection: {
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  rootHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rootName: {
    fontSize: 18,
    fontWeight: '600',
  },
  rescanLink: {
    color: '#3b82f6',
  },
  empty: {
    opacity: 0.6,
    marginTop: 4,
  },
  playlist: {
    marginTop: 8,
    paddingLeft: 8,
  },
  playlistName: {
    fontSize: 15,
  },
  trackCount: {
    fontSize: 12,
    opacity: 0.6,
  },
});

export default App;

/**
 * BPMix - Stage 3: playlist queue playback with loop modes and shuffle,
 * on top of Stage 2's single-track playback.
 * @format
 */

import type { FileRef, GrantedRoot, LoopMode, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
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
  mdiFolder,
  mdiFolderPlus,
  mdiMusicNote,
  mdiPause,
  mdiPlay,
  mdiPlaylistMusic,
  mdiRefresh,
  mdiRepeat,
  mdiRepeatOnce,
  mdiShuffle,
  mdiSkipNext,
  mdiSkipPrevious,
} from '@mdi/js';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { createAudioEngine } from './src/adapters/audioEngine';
import { createCoverArtResizer } from './src/adapters/coverArtResizer';
import { createFileAccess } from './src/adapters/fileAccess';
import { createLibraryStore } from './src/adapters/libraryStore';
import { MemoryOverlay } from './src/debug/MemoryOverlay';

// The overlay's 500ms poll + up to 120 re-rendered bars was noticeably
// janking the UI, especially layered on top of the Stage 4 analysis pass
// already competing for the JS thread - off by default, flip back on when
// actively chasing a memory issue.
const SHOW_MEMORY_OVERLAY = false;

const TRANSPORT_THROTTLE_MS = 300;
// A real settings screen (Stage 8) would make this configurable - for now
// it's fixed, per CLAUDE.md's TODO to drop the user-facing crossfade control.
const DEFAULT_CROSSFADE_SECONDS = 8;

const fileAccess = createFileAccess();
const libraryStore = createLibraryStore();
const audioEngine = createAudioEngine(fileAccess);
const coverArtResizer = createCoverArtResizer();

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
      void ensureTrackAnalyzed(libraryStore, ref, decoded, audioEngine);
    },
  },
);

// playlistPlayer/audioEngine are module-level singletons, but the native
// AudioContext they wrap isn't torn down just because a Fast Refresh reload
// discards this module's JS references to it - without this, a track kept
// playing (audibly) straight through every reload during this session's own
// on-device testing, orphaned from the fresh instances the reloaded module
// creates. Metro (this project's bundler) injects a per-module `module.hot`
// only in dev builds - see its require.js polyfill - so this is a no-op in
// production; there's no ambient type for it, hence the local declare.
declare const module: { hot?: { dispose: (cb: () => void) => void } } | undefined;
if (typeof module !== 'undefined' && module?.hot) {
  module.hot.dispose(() => {
    playlistPlayer.pause();
  });
}

const LOOP_MODE_CYCLE: LoopMode[] = ['off', 'all', 'one'];
// 'off' reuses the repeat-all glyph dimmed, rather than a distinct
// "repeat off" icon - Segoe Fluent Icons (the Windows Icon renderer's font)
// has no such glyph, so state is conveyed by icon shape + color together:
// off = dim mdiRepeat, all = lit mdiRepeat, one = lit mdiRepeatOnce.
const LOOP_MODE_ICON: Record<LoopMode, string> = { off: mdiRepeat, all: mdiRepeat, one: mdiRepeatOnce };

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

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
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

  useEffect(() => {
    reportError = (err) => setError(String(err));
    return () => {
      reportError = () => {};
    };
  }, []);

  useEffect(() => {
    notifyAdvance = () => setPlayerState(playlistPlayer.getState());
    return () => {
      notifyAdvance = () => {};
    };
  }, []);

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
    refresh().catch((err) => setError(String(err)));
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      setPlayerState(playlistPlayer.getState());
      playlistPlayer.checkPreload(); // Stage 6 lookahead - reuses this poll instead of a second timer
    }, 200);
    return () => clearInterval(interval);
  }, []);

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
      if (playlistPlayer.getState().currentFileId === track.fileId) {
        playlistPlayer.play();
      } else {
        await playlistPlayer.setPlaylist(playlist.trackFileIds, track.fileId);
      }
      setPlayerState(playlistPlayer.getState());
    },
    [],
  );

  const togglePause = useCallback(() => {
    if (!transportActionAllowed()) return;
    if (playerState.track.status === 'playing') {
      playlistPlayer.pause();
    } else {
      playlistPlayer.play();
    }
    setPlayerState(playlistPlayer.getState());
  }, [playerState.track.status]);

  const seekTo = useCallback((positionSeconds: number) => {
    if (!transportActionAllowed()) return;
    playlistPlayer.seek(positionSeconds);
    setPlayerState(playlistPlayer.getState());
  }, []);

  const goNext = useCallback(async (options?: { force?: boolean }) => {
    if (!transportActionAllowed()) return;
    await playlistPlayer.next(options);
    setPlayerState(playlistPlayer.getState());
  }, []);

  const goPrevious = useCallback(async (options?: { force?: boolean }) => {
    if (!transportActionAllowed()) return;
    await playlistPlayer.previous(options);
    setPlayerState(playlistPlayer.getState());
  }, []);

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
  }, [playerState.loopMode]);

  const toggleShuffle = useCallback(() => {
    playlistPlayer.setShuffle(!playerState.shuffleEnabled);
    setPlayerState(playlistPlayer.getState());
  }, [playerState.shuffleEnabled]);

  const [volume, setVolumeState] = useState(() => playlistPlayer.getVolume());
  useEffect(() => {
    libraryStore.getPlaybackState().then((stored) => {
      if (stored) {
        playlistPlayer.setVolume(stored.volume);
        setVolumeState(stored.volume);
      }
    });
  }, []);
  const handleVolumeChange = useCallback((value: number) => {
    playlistPlayer.setVolume(value);
    setVolumeState(value);
    // Persisted so the next launch doesn't blast out at whatever volume
    // happened to be in effect before it's set once - merges onto whatever
    // playback state (loop/shuffle/etc.) is already stored, if any, rather
    // than clobbering it back to defaults.
    libraryStore.getPlaybackState().then((stored) => {
      void libraryStore.putPlaybackState({
        playlistId: stored?.playlistId ?? null,
        currentTrackFileId: stored?.currentTrackFileId ?? null,
        positionSeconds: stored?.positionSeconds ?? 0,
        loopMode: stored?.loopMode ?? 'off',
        shuffleEnabled: stored?.shuffleEnabled ?? false,
        volume: value,
      });
    });
  }, []);

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
      // duration (a manual skip's MANUAL_SKIP_CROSSFADE_SECONDS is much
      // shorter than the natural end-of-track crossfadeSeconds default
      // below), not a static preview of a future one.
      return { fadeStartSeconds: 0, fadeDurationSeconds: pendingIncoming.fadeDurationSeconds, incomingStartSeconds: 0 };
    }
    if (playerState.track.durationSeconds <= 0) return null;
    return computeTransitionPlan(playerState.track.durationSeconds, DEFAULT_CROSSFADE_SECONDS);
  }, [pendingIncoming, playerState.track.durationSeconds]);

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

  const isLoadingTrack = playerState.track.status === 'loading';

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
          {isLoadingTrack ? (
            <View style={styles.buttonRow}>
              <ActivityIndicator size="small" color={colors.subtleText} style={styles.buttonSpinner} />
              <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
                Loading… · track {displayTrackNumber}/{playerState.totalTracks}
              </Text>
            </View>
          ) : (
            <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
              {formatSeconds(displayPositionSeconds)} / {formatSeconds(displayDurationSeconds)} (
              {playerState.track.status}) · track {displayTrackNumber}/{playerState.totalTracks}
            </Text>
          )}
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
        <Pressable
          style={[styles.transportIconButton, playerState.loopMode !== 'off' && styles.transportIconButtonActive]}
          onPress={cycleLoopMode}
        >
          <Icon path={LOOP_MODE_ICON[playerState.loopMode]} size={18} color="white" />
        </Pressable>
        <Pressable style={styles.controlButton} onPress={handlePreviousPress}>
          <Icon path={mdiSkipPrevious} size={20} color="white" />
        </Pressable>
        <Pressable style={[styles.controlButton, styles.controlButtonPrimary]} onPress={togglePause}>
          <Icon path={playerState.track.status === 'playing' ? mdiPause : mdiPlay} size={30} color="white" />
        </Pressable>
        <Pressable style={styles.controlButton} onPress={handleNextPress}>
          <Icon path={mdiSkipNext} size={20} color="white" />
        </Pressable>
        <Pressable
          style={[styles.transportIconButton, playerState.shuffleEnabled && styles.transportIconButtonActive]}
          onPress={toggleShuffle}
        >
          <Icon path={mdiShuffle} size={18} color="white" />
        </Pressable>
      </View>
      <VolumeSlider volume={volume} onChangeVolume={handleVolumeChange} />
    </View>
  );

  if (screen.kind === 'playlist') {
    const { playlist, tracksById } = screen;
    return (
      <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
        {__DEV__ && SHOW_MEMORY_OVERLAY && <MemoryOverlay />}
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
          initialNumToRender={20}
        />
      </View>
    );
  }

  // busyRootId is also set for a brand-new root while it's being scanned,
  // before it exists in rootsWithLibrary - the "Scanning…" link next to an
  // already-listed root's name doesn't cover that case, so this is the only
  // signal available while a first-time Add Folder scan is running.
  const isAddingFolder = busyRootId !== null && !rootsWithLibrary.some(({ root }) => root.id === busyRootId);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      {__DEV__ && SHOW_MEMORY_OVERLAY && <MemoryOverlay />}
      <IconLabel
        path={mdiMusicNote}
        text="BPMix"
        color={colors.text}
        iconSize={28}
        textStyle={styles.title}
        containerStyle={styles.titleRow}
      />
      <Pressable style={[styles.button, isAddingFolder && styles.buttonDisabled]} onPress={addFolder} disabled={isAddingFolder}>
        {isAddingFolder ? (
          <View style={styles.buttonRow}>
            <ActivityIndicator color="#fff" style={styles.buttonSpinner} />
            <Text style={styles.buttonText}>Scanning folder…</Text>
          </View>
        ) : (
          <IconLabel path={mdiFolderPlus} text="Add Folder" color="white" iconSize={18} textStyle={styles.buttonText} />
        )}
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
    alignItems: 'center',
    paddingTop: 24,
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
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  buttonSpinner: {
    marginRight: 8,
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
  controlButtonPrimary: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#2563eb',
  },
  // Loop/shuffle: smaller and dimmer than the transport buttons they flank -
  // secondary controls, not primary ones - lighting up (transportIconButtonActive)
  // when their mode is non-default, since the icon glyph alone can't carry
  // on/off state for shuffle (same icon either way).
  transportIconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#475569',
    alignItems: 'center',
    justifyContent: 'center',
  },
  transportIconButtonActive: {
    backgroundColor: '#3b82f6',
  },
  list: {
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

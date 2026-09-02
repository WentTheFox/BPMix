import type {
  AnalysisResult,
  FileRef,
  GrantedRoot,
  LoopMode,
  PlaylistPlayerState,
  PlaylistRecord,
  TrackRecord,
} from '@bpmix/core';
import {
  computeCrossfadeVisualization,
  computeTransitionPlan,
  ensureTrackAnalyzed,
  PlaylistPlayer,
  realTimeForOutgoingPosition,
  scanRoot,
} from '@bpmix/core';
import { CrossfadePreview } from '@bpmix/ui';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { createAudioEngine } from './adapters/audioEngine';
import { createFileAccess } from './adapters/fileAccess';
import { createLibraryStore } from './adapters/libraryStore';

const DOUBLE_PRESS_DELAY_MS = 300;
const TRANSPORT_THROTTLE_MS = 300;
// A real settings screen (Stage 8) would persist this - for now it's a
// simple in-memory control (see the "Crossfade" stepper below) that starts
// here and can be adjusted live.
const DEFAULT_CROSSFADE_SECONDS = 8;
const MIN_CROSSFADE_SECONDS = 1;
const MAX_CROSSFADE_SECONDS = 20;

/** Single press fires onSingle after a short delay; a second press within that window fires onDouble instead. */
function useDoublePressHandler(onSingle: () => void, onDouble: () => void): () => void {
  const pendingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (pendingTimeout.current) {
      clearTimeout(pendingTimeout.current);
      pendingTimeout.current = null;
      onDouble();
      return;
    }
    pendingTimeout.current = setTimeout(() => {
      pendingTimeout.current = null;
      onSingle();
    }, DOUBLE_PRESS_DELAY_MS);
  }, [onSingle, onDouble]);
}

const fileAccess = createFileAccess();
const libraryStore = createLibraryStore();
const audioEngine = createAudioEngine(fileAccess);

const ANALYSIS_RETRY_MS = 500;

/**
 * Fetches a track's analysis, retrying on a short interval until it
 * resolves. JIT analysis (Stage 4) computes it asynchronously right after
 * a track is decoded - the very first fetch immediately after selecting a
 * track can easily land before that write actually completes, and a
 * one-shot fetch would then show nothing for that track's whole session,
 * since nothing else ever triggers a refetch once analysis does finish.
 */
function useTrackAnalysis(fileId: string | null): AnalysisResult | null {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  useEffect(() => {
    setAnalysis(null);
    if (!fileId) return;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    const tryFetch = () => {
      libraryStore.getAnalysis(fileId).then((result) => {
        if (cancelled) return;
        if (result) {
          setAnalysis(result);
        } else {
          retryTimeout = setTimeout(tryFetch, ANALYSIS_RETRY_MS);
        }
      });
    };
    tryFetch();
    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [fileId]);
  return analysis;
}

function trackToFileRef(track: TrackRecord): FileRef {
  return {
    id: track.fileId,
    name: track.relativePath.split('/').pop() ?? track.relativePath,
    relativePath: track.relativePath,
    sizeBytes: track.sizeBytes,
    lastModifiedMs: track.lastModifiedMs,
  };
}

function trackDisplayName(track: TrackRecord): string {
  return track.relativePath.split('/').pop() ?? track.relativePath;
}

// PlaylistPlayer resolves a fileId to a FileRef via this module-level map,
// kept pointed at whichever playlist screen is currently open (there's only
// ever one active player/screen in this app). setError is likewise bridged
// in on mount so the player's async load/decode errors reach the UI.
let activeTracksById = new Map<string, TrackRecord>();
let reportError: (error: unknown) => void = () => {};

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
    // Stage 7: the same analysis lookup and duration the debug preview below
    // uses for computeTransitionPlan - PlaylistPlayer schedules the actual
    // audio crossfade from it, so what's previewed and what's heard match.
    resolveAnalysis: (fileId) => libraryStore.getAnalysis(fileId).then((result) => result ?? undefined),
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

const TrackRow = memo(function TrackRow({
  track,
  isCurrent,
  isPlaying,
  colors,
  onPress,
}: {
  track: TrackRecord;
  isCurrent: boolean;
  isPlaying: boolean;
  colors: Colors;
  onPress: (track: TrackRecord) => void;
}) {
  return (
    <Pressable style={styles.trackRow} onPress={() => onPress(track)}>
      <Text style={[styles.trackName, { color: isCurrent ? '#3b82f6' : colors.text }]} numberOfLines={1}>
        {isCurrent && isPlaying ? '▶ ' : ''}
        {trackDisplayName(track)}
      </Text>
    </Pressable>
  );
});

/**
 * Tap-to-seek only, deliberately not drag-to-scrub: a drag would need to
 * call seek() continuously as the finger/mouse moves, which is exactly the
 * rapid-fire native-source-churn pattern that crashes react-native-audio-api
 * on Android. A tap fires exactly one seek() call, same as any other
 * transport button.
 */
function SeekBar({
  positionSeconds,
  durationSeconds,
  onSeekTo,
}: {
  positionSeconds: number;
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
}) {
  // event.nativeEvent.locationX is unreliable on react-native-web (comes
  // back undefined there, unlike native RN) - measure() + pageX works on
  // both, so that's used instead of locationX everywhere.
  // Typed loosely: RN's own ref type here (ReactNativeElement) isn't a
  // public export, and this is a narrow, self-contained use of .measure().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const widthRef = useRef(0);
  const pageXRef = useRef(0);

  const measureTrack = () => {
    trackRef.current?.measure((_x: number, _y: number, width: number, _height: number, pageX: number) => {
      widthRef.current = width;
      pageXRef.current = pageX;
    });
  };

  const handleLayout = (_event: LayoutChangeEvent) => {
    measureTrack();
  };

  const handlePress = (event: GestureResponderEvent) => {
    if (widthRef.current <= 0 || durationSeconds <= 0) return;
    // Prefer locationX (element-relative, no measure() dependency) when
    // it's actually a usable number - true on native RN. Falls back to
    // pageX minus the measured element offset, since locationX comes back
    // undefined on react-native-web.
    const relativeX = Number.isFinite(event.nativeEvent.locationX)
      ? event.nativeEvent.locationX
      : event.nativeEvent.pageX - pageXRef.current;
    if (!Number.isFinite(relativeX)) return;
    const fraction = Math.max(0, Math.min(1, relativeX / widthRef.current));
    onSeekTo(fraction * durationSeconds);
  };

  const fillFraction = durationSeconds > 0 ? Math.max(0, Math.min(1, positionSeconds / durationSeconds)) : 0;

  return (
    <Pressable
      ref={trackRef}
      style={styles.seekBarTrack}
      onLayout={handleLayout}
      onPress={handlePress}
      hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
    >
      <View style={[styles.seekBarFill, { width: `${fillFraction * 100}%` }]} />
    </Pressable>
  );
}

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

  useEffect(() => {
    reportError = (err) => setError(String(err));
    return () => {
      reportError = () => {};
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

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      if (!transportActionAllowed()) return;
      playlistPlayer.seek(playerState.track.positionSeconds + deltaSeconds);
      setPlayerState(playlistPlayer.getState());
    },
    [playerState.track.positionSeconds],
  );

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

  const nowPlayingTrack = playerState.currentFileId ? activeTracksById.get(playerState.currentFileId) : undefined;

  // Debug view (Stage 4 exit criterion): shows the currently playing
  // track's computed BPM/gain, proving analysis actually ran and produced
  // real numbers, not just that it didn't crash.
  const currentAnalysis = useTrackAnalysis(playerState.currentFileId);

  // Stage 7 debug view: preview of the crossfade into whatever's queued up
  // next, computed from the same TransitionPlan/visualization data real
  // playback scheduling will use - lets the alignment/fade math be checked
  // by eye before (and regardless of) actual audio engine wiring.
  const [nextFileId, setNextFileId] = useState<string | null>(null);
  useEffect(() => {
    setNextFileId(playlistPlayer.getNextFileId());
  }, [playerState.position, playerState.loopMode, playerState.shuffleEnabled, playerState.totalTracks]);
  const nextAnalysis = useTrackAnalysis(nextFileId);
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

  const transitionPlan = useMemo(() => {
    if (!currentAnalysis || !nextAnalysis || playerState.track.durationSeconds <= 0) return null;
    return computeTransitionPlan(
      { endWindow: currentAnalysis.endWindow, durationSeconds: playerState.track.durationSeconds },
      { startWindow: nextAnalysis.startWindow },
      crossfadeSeconds,
    );
  }, [currentAnalysis, nextAnalysis, playerState.track.durationSeconds, crossfadeSeconds]);

  const crossfadeVisualization = useMemo(() => {
    if (!transitionPlan || !currentAnalysis || !nextAnalysis) return null;
    return computeCrossfadeVisualization(transitionPlan, currentAnalysis.endWindow.bpm, nextAnalysis.startWindow.bpm);
  }, [transitionPlan, currentAnalysis, nextAnalysis]);

  // The preview's timeline is relative to the fade start (t=0) - converting
  // live playback position into that same frame lets the preview draw a
  // real-time progress line instead of just a static plan. Uses the same
  // piecewise (flat/ramp/flat) math the visualization itself is built from,
  // since a plain subtraction is only correct outside the ramp phase.
  const crossfadeProgressSeconds = transitionPlan
    ? realTimeForOutgoingPosition(transitionPlan, playerState.track.positionSeconds)
    : null;

  const nowPlayingBar = playerState.currentFileId && (
    <View style={styles.nowPlaying}>
      <Text style={[styles.nowPlayingName, { color: colors.text }]} numberOfLines={1}>
        {nowPlayingTrack ? trackDisplayName(nowPlayingTrack) : playerState.currentFileId}
      </Text>
      <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
        {formatSeconds(playerState.track.positionSeconds)} / {formatSeconds(playerState.track.durationSeconds)} (
        {playerState.track.status}) · track {playerState.position + 1}/{playerState.totalTracks}
      </Text>
      {currentAnalysis && (
        <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
          Tempo: start {currentAnalysis.startWindow.bpm.toFixed(0)} BPM · end {currentAnalysis.endWindow.bpm.toFixed(0)} BPM
          · gain {currentAnalysis.normalizationGain.toFixed(2)}x
        </Text>
      )}
      {crossfadeVisualization && (
        <CrossfadePreview
          outgoingName={nowPlayingTrack ? trackDisplayName(nowPlayingTrack) : 'Current track'}
          incomingName={nextTrack ? trackDisplayName(nextTrack) : 'Next track'}
          visualization={crossfadeVisualization}
          progressSeconds={crossfadeProgressSeconds}
        />
      )}
      <SeekBar
        positionSeconds={playerState.track.positionSeconds}
        durationSeconds={playerState.track.durationSeconds}
        onSeekTo={seekTo}
      />
      <View style={styles.playerControlsRow}>
        <Pressable style={styles.controlButton} onPress={handlePreviousPress}>
          <Text style={styles.controlIcon}>⏮</Text>
        </Pressable>
        <Pressable style={styles.controlButtonWide} onPress={() => seekBy(-10)}>
          <Text style={styles.controlIconWide}>⏪10</Text>
        </Pressable>
        <Pressable style={[styles.controlButton, styles.controlButtonPrimary]} onPress={togglePause}>
          <Text style={[styles.controlIcon, styles.controlIconPrimary]}>
            {playerState.track.status === 'playing' ? '⏸' : '▶'}
          </Text>
        </Pressable>
        <Pressable style={styles.controlButtonWide} onPress={() => seekBy(10)}>
          <Text style={styles.controlIconWide}>10⏩</Text>
        </Pressable>
        <Pressable style={styles.controlButton} onPress={handleNextPress}>
          <Text style={styles.controlIcon}>⏭</Text>
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
    </View>
  );

  if (screen.kind === 'playlist') {
    const { playlist, tracksById } = screen;
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Pressable onPress={() => setScreen({ kind: 'library' })} style={styles.backRow}>
          <Text style={[styles.backLink, { color: colors.text }]}>← {playlist.name}</Text>
        </Pressable>
        {error && <Text style={styles.error}>{error}</Text>}
        {nowPlayingBar}
        <FlatList
          style={styles.list}
          data={playlist.trackFileIds}
          keyExtractor={(fileId, index) => `${fileId}-${index}`}
          renderItem={({ item: fileId }) => {
            const track = tracksById.get(fileId);
            if (!track) return null;
            return (
              <TrackRow
                track={track}
                isCurrent={playerState.currentFileId === fileId}
                isPlaying={playerState.track.status === 'playing'}
                colors={colors}
                onPress={(t) => void playFromTrack(playlist, tracksById, t)}
              />
            );
          }}
          initialNumToRender={30}
          windowSize={7}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.text }]}>BPMix</Text>
      <Pressable style={styles.button} onPress={addFolder}>
        <Text style={styles.buttonText}>Add Folder</Text>
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
              <Text style={[styles.rootName, { color: colors.text }]}>{root.displayName}</Text>
              <Pressable onPress={() => rescan(root.id)} disabled={busyRootId === root.id}>
                <Text style={styles.rescanLink}>{busyRootId === root.id ? 'Scanning…' : 'Rescan'}</Text>
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
                <Text style={[styles.playlistName, { color: colors.text }]}>{playlist.name}</Text>
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
    height: '100vh',
    alignItems: 'center',
    paddingTop: 48,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 16,
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
  nowPlayingName: {
    fontSize: 15,
    fontWeight: '600',
  },
  nowPlayingTime: {
    fontSize: 12,
    marginTop: 2,
  },
  seekBarTrack: {
    height: 10,
    marginTop: 12,
    borderRadius: 5,
    backgroundColor: 'rgba(59, 130, 246, 0.25)',
    overflow: 'hidden',
  },
  seekBarFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
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
  controlIcon: {
    color: 'white',
    fontSize: 20,
  },
  controlIconWide: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
  },
  controlIconPrimary: {
    fontSize: 30,
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
  trackRow: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  trackName: {
    fontSize: 14,
  },
});

export default App;

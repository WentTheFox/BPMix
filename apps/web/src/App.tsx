import type { FileRef, GrantedRoot, LoopMode, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import {
  computeTransitionPlan,
  ensureTrackAnalyzed,
  equalPowerGain,
  errorMessage,
  findAutoLyricsMatch,
  formatTrackTitle,
  isMetadataCurrent,
  PlaylistPlayer,
  realTimeForOutgoingPosition,
  scanLibraryMetadata,
  scanLyricsRoot,
  scanRoot,
} from '@bpmix/core';
import {
  AppTitle,
  CROSSFADE_ART_TRANSITION_MS,
  Icon,
  IconLabel,
  LibraryScreen,
  LoopButton,
  LyricsFolderSection,
  NowPlayingBar,
  ShuffleButton,
  TrackList,
  useCoverArt,
  useDoublePressHandler,
  useFadeInOnChange,
  usePlaybackPersistence,
  useThemeColors,
  useTrackMetadata,
} from '@bpmix/ui';
import type { RootWithLibrary } from '@bpmix/ui';
import { mdiArrowLeft, mdiFastForward10, mdiPause, mdiPlay, mdiRewind10, mdiSkipNext, mdiSkipPrevious } from '@mdi/js';
import type { CSSProperties } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DimensionValue } from 'react-native';
import { InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { createAudioEngine } from './adapters/audioEngine';
import { createCoverArtResizer } from './adapters/coverArtResizer';
import { createCompositeFileAccess } from './adapters/fileAccess.composite';
import { createLibraryStore } from './adapters/libraryStore';

const TRANSPORT_THROTTLE_MS = 300;
// A real settings screen (Stage 8) would make this configurable - for now
// it's fixed, per CLAUDE.md's TODO to drop the user-facing crossfade control.
const DEFAULT_CROSSFADE_SECONDS = 8;

// File System Access API is Chromium-only (no Firefox/Safari support as of
// this writing) - the composite adapter's server roots (Docker self-host)
// work regardless, but "Add Folder" itself needs this to pick local folders.
const SUPPORTS_DIRECTORY_PICKER = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
const SELF_HOSTING_DOCS_URL = 'https://github.com/WentTheFox/BPMix/blob/main/apps/server/README.md';
// A real DOM <a>, not an RN Text/Pressable - react-native-web's StyleSheet
// objects aren't meant for raw DOM elements, so this is a plain CSS object.
const webLinkStyle: CSSProperties = { color: 'inherit', textDecoration: 'underline', fontWeight: 600 };

const fileAccess = createCompositeFileAccess();
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

type Screen =
  | { kind: 'library' }
  | { kind: 'playlist'; root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };

function App() {
  const colors = useThemeColors();
  const [rootsWithLibrary, setRootsWithLibrary] = useState<RootWithLibrary[]>([]);
  const [lyricsRoots, setLyricsRoots] = useState<GrantedRoot[]>([]);
  const [matchedLyricsCount, setMatchedLyricsCount] = useState<number | null>(null);
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
    reportError = (err) => setError(errorMessage(err));
    return () => {
      reportError = () => {};
    };
  }, []);

  const refresh = useCallback(async () => {
    const roots = await fileAccess.listGrantedRoots();
    const rootsByKind = await Promise.all(roots.map(async (root) => ({ root, kind: await libraryStore.getRootKind(root.id) })));
    const musicRoots = rootsByKind.filter(({ kind }) => kind === 'music').map(({ root }) => root);
    const lyricsRootList = rootsByKind.filter(({ kind }) => kind === 'lyrics').map(({ root }) => root);
    setLyricsRoots(lyricsRootList);

    // Each root's scan is isolated in its own try/catch - one bad root
    // (a moved/deleted folder, a native file-access error) used to reject
    // this whole Promise.all before setRootsWithLibrary ever ran, which
    // blanked the ENTIRE library (every other, perfectly fine root included)
    // on every refresh/relaunch until the bad root was manually removed.
    // Now a failing root just reports its own error and drops out, leaving
    // the rest of the library visible.
    const withLibrary = (
      await Promise.all(
        musicRoots.map(async (root) => {
          try {
            let [playlists, tracks] = await Promise.all([
              libraryStore.listPlaylists(root.id),
              libraryStore.listTracks(root.id),
            ]);
            if (playlists.length === 0 && tracks.length === 0) {
              // A root can reach listGrantedRoots() without ever going through
              // addFolder's explicit requestRoot+scanRoot flow - e.g. a
              // composite-adapter root the self-hosted server exposes just by
              // having a volume mounted. Scan it now instead of silently
              // showing an empty library until the user notices and clicks
              // Rescan themselves.
              await scanRoot(fileAccess, libraryStore, root.id);
              [playlists, tracks] = await Promise.all([
                libraryStore.listPlaylists(root.id),
                libraryStore.listTracks(root.id),
              ]);
            }
            return { root, playlists, tracksById: new Map(tracks.map((t) => [t.fileId, t])) };
          } catch (err) {
            setError(errorMessage(err));
            return null;
          }
        }),
      )
    ).filter((entry): entry is RootWithLibrary => entry !== null);
    setRootsWithLibrary(withLibrary);

    // Auto-assign any track that doesn't already have a lyrics match (an
    // existing manual override is never overwritten here - getLyricsAssignment
    // returning non-null short-circuits before findAutoLyricsMatch runs).
    // Recomputed on every refresh rather than cached, since a lyrics folder's
    // contents can change between scans same as a music root's can.
    if (lyricsRootList.length > 0) {
      setMatchedLyricsCount(null);
      const allTracks = withLibrary.flatMap(({ tracksById }) => [...tracksById.values()]);
      // Same per-root isolation as the music roots above - one lyrics root
      // failing to scan shouldn't block matching against the ones that work.
      const lrcFiles = (
        await Promise.all(
          lyricsRootList.map(async (root) => {
            try {
              return await scanLyricsRoot(fileAccess, root.id);
            } catch (err) {
              setError(errorMessage(err));
              return [];
            }
          }),
        )
      ).flat();
      const candidates = lrcFiles.map((file) => ({ fileId: file.id, name: file.name }));
      let matched = 0;
      await Promise.all(
        allTracks.map(async (track) => {
          const existing = await libraryStore.getLyricsAssignment(track.fileId);
          if (existing) {
            matched++;
            return;
          }
          const trackName = track.relativePath.split('/').pop() ?? track.relativePath;
          const match = findAutoLyricsMatch(trackName, candidates);
          if (match) {
            await libraryStore.putLyricsAssignment(track.fileId, match.fileId);
            matched++;
          }
        }),
      );
      setMatchedLyricsCount(matched);
    } else {
      setMatchedLyricsCount(null);
    }
    // Fire-and-forget: fills in real titles/artists as it goes (each row's
    // useTrackMetadata retry-polls the store), rather than blocking the
    // library screen on reading every file's tag bytes up front. Cheap to
    // call again on every refresh - already-fresh tracks are skipped
    // without a re-read (see scanLibraryMetadata/isMetadataFresh).
    // Deferred to runAfterInteractions - reading/parsing tag bytes is real
    // synchronous JS work (there's no worker-thread equivalent available
    // here; RN's JS environment is single-threaded, and this doesn't run
    // in a browser tab that could use a real Web Worker), so starting it
    // only once whatever brought the user to this screen has finished
    // animating keeps it from competing with that for the JS thread.
    InteractionManager.runAfterInteractions(() => {
      void scanLibraryMetadata(fileAccess, libraryStore, withLibrary.flatMap(({ tracksById }) => [...tracksById.values()]), {
        resizer: coverArtResizer,
        // Bumps whatever's actually on screen (now playing + up next) ahead
        // of the rest of the library, evaluated fresh on every step - so a
        // large stale-parser-version rescan reaches the tracks the user is
        // looking at long before it would in plain list order.
        getPriorityFileIds: () => {
          const state = playlistPlayer.getState();
          const nextFileId = playlistPlayer.getNextFileId();
          return [state.currentFileId, nextFileId].filter((id): id is string => id != null);
        },
      });
    });
    return withLibrary;
  }, []);

  const { isRestoring, persistPlaybackPatch, persistPositionIfDue } = usePlaybackPersistence({
    libraryStore,
    playlistPlayer,
    refresh,
    setPlayerState,
    setActiveTracksById: (tracksById) => {
      activeTracksById = tracksById;
    },
    onRestoreScreen: (root, playlist, tracksById) => setScreen({ kind: 'playlist', root, playlist, tracksById }),
    onError: (err) => setError(errorMessage(err)),
  });

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

  useEffect(() => {
    const interval = setInterval(() => {
      const state = playlistPlayer.getState();
      setPlayerState(state);
      playlistPlayer.checkPreload(); // Stage 6 lookahead - reuses this poll instead of a second timer
      persistPositionIfDue(state);
    }, 200);
    return () => clearInterval(interval);
  }, [persistPositionIfDue]);

  const addFolder = useCallback(async () => {
    setError(null);
    try {
      const root = await fileAccess.requestRoot();
      if (!root) return; // user cancelled the picker
      setBusyRootId(root.id);
      await scanRoot(fileAccess, libraryStore, root.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyRootId(null);
    }
  }, [refresh]);

  const rescan = useCallback(
    async (rootId: string) => {
      setError(null);
      setBusyRootId(rootId);
      try {
        // Lyrics roots have nothing to scan into scanRoot's playlist/track
        // tables - refresh() below does their .lrc rescan+rematch itself.
        if ((await libraryStore.getRootKind(rootId)) === 'music') {
          await scanRoot(fileAccess, libraryStore, rootId);
        }
        await refresh();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyRootId(null);
      }
    },
    [refresh],
  );

  const addLyricsFolder = useCallback(async () => {
    setError(null);
    try {
      const root = await fileAccess.requestRoot();
      if (!root) return; // user cancelled the picker
      await libraryStore.setRootKind(root.id, 'lyrics');
      setBusyRootId(root.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyRootId(null);
    }
  }, [refresh]);

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
        // setPlaylist() sets the new position/loading status synchronously
        // before its first await (decoding the file) - grabbing state right
        // after calling it, rather than only once the whole decode resolves,
        // is what makes the row highlight and "now playing" bar appear the
        // instant you tap instead of waiting out the full decode.
        const setPlaylistPromise = playlistPlayer.setPlaylist(playlist.trackFileIds, track.fileId);
        setPlayerState(playlistPlayer.getState());
        await setPlaylistPromise;
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

  const transitionPlan = useMemo(() => {
    if (pendingIncoming) {
      // A crossfade is genuinely happening right now - reflect its real
      // duration (a manual skip's fadeDurationSeconds is much shorter than
      // the natural end-of-track DEFAULT_CROSSFADE_SECONDS below), not a
      // static preview of a future one.
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
  // Feeds CrossfadeArt's spin *speed* (not opacity) - see its doc for why.
  // A crossfade only ever runs while actually playing, so pendingIncoming
  // already implies isPlaying - this only matters for the paused case,
  // where the record shouldn't keep spinning: crossfadeFraction isn't
  // actually null then (it's some out-of-range value from
  // realTimeForOutgoingPosition, which equalPowerGain clamps close to 1/0
  // on its own), so the "not playing" override has to apply after that
  // computation, not just to its null-fallback branch.
  const isPlaying = pendingIncoming ? true : playerState.track.status === 'playing';
  const outgoingGain = isPlaying
    ? crossfadeFraction == null
      ? 1
      : equalPowerGain(crossfadeFraction, true, fadeDurationSeconds)
    : 0;
  const incomingGain = crossfadeFraction == null ? 0 : equalPowerGain(crossfadeFraction, false, fadeDurationSeconds);
  const displayPositionSeconds = pendingIncoming ? pendingIncoming.positionSeconds : playerState.track.positionSeconds;
  const displayDurationSeconds = pendingIncoming ? pendingIncoming.durationSeconds : playerState.track.durationSeconds;
  // Feeds CrossfadeArt's tonearm needle positions - the outgoing track's
  // own position/duration regardless of any pending crossfade (it keeps
  // playing/advancing independently of the incoming preview), and the
  // incoming track's only once a crossfade is actually bringing it in
  // (otherwise it hasn't started, so its needle stays parked at the edge).
  const outgoingProgress = playerState.track.durationSeconds > 0 ? playerState.track.positionSeconds / playerState.track.durationSeconds : 0;
  const incomingProgress = pendingIncoming && pendingIncoming.durationSeconds > 0 ? pendingIncoming.positionSeconds / pendingIncoming.durationSeconds : 0;

  // Title/"up next" text only actually changes CROSSFADE_ART_TRANSITION_MS
  // after outgoingTrack/incomingTrack do, not the instant playback state
  // changes (which is also when metadata/art prefetching starts) - lines
  // the text swap up with the same beat as CrossfadeArt's own disc
  // swap/fade below instead of each updating at its own independent
  // moment. A plain timer (matching CrossfadeArt's own constant) rather
  // than hooking into that component's internal animation completion -
  // far more robust than threading a callback through Animated's
  // completion handling, which can report "interrupted" under rapid track
  // changes and leave a callback-based sync stuck.
  const [settledCurrentKey, setSettledCurrentKey] = useState<string | null>(outgoingTrack?.fileId ?? null);
  const [settledNextKey, setSettledNextKey] = useState<string | null>(incomingTrack?.fileId ?? null);
  useEffect(() => {
    const key = outgoingTrack?.fileId ?? null;
    if (key === settledCurrentKey) return;
    const timeout = setTimeout(() => setSettledCurrentKey(key), CROSSFADE_ART_TRANSITION_MS);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoingTrack?.fileId]);
  useEffect(() => {
    const key = incomingTrack?.fileId ?? null;
    if (key === settledNextKey) return;
    const timeout = setTimeout(() => setSettledNextKey(key), CROSSFADE_ART_TRANSITION_MS);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingTrack?.fileId]);
  const settledCurrentTrack = settledCurrentKey ? activeTracksById.get(settledCurrentKey) : undefined;
  const settledCurrentMetadata = useTrackMetadata(libraryStore, settledCurrentKey);
  const settledNextTrack = settledNextKey ? activeTracksById.get(settledNextKey) : undefined;
  const settledNextMetadata = useTrackMetadata(libraryStore, settledNextKey);

  // Fades the now-playing block in on every settled track change, keyed on
  // identity (fileId) rather than on what triggered the change - the same
  // fade plays whether it arrived via a manual skip, a natural
  // end-of-track advance, or picking a different track in the list
  // outright.
  const nowPlayingOpacity = useFadeInOnChange(settledCurrentKey);
  const upNextOpacity = useFadeInOnChange(settledNextKey);

  const nowPlayingBar = playerState.currentFileId && (
    <NowPlayingBar
      colors={colors}
      title={settledCurrentTrack ? formatTrackTitle(settledCurrentMetadata, settledCurrentTrack) : playerState.currentFileId}
      upNextTitle={settledNextTrack ? formatTrackTitle(settledNextMetadata, settledNextTrack) : null}
      nowPlayingOpacity={nowPlayingOpacity}
      upNextOpacity={upNextOpacity}
      currentTrackKey={outgoingTrack?.fileId ?? null}
      currentArtUri={outgoingCoverArt}
      currentGain={outgoingGain}
      currentProgress={outgoingProgress}
      nextTrackKey={incomingTrack?.fileId ?? null}
      nextArtUri={incomingCoverArt}
      nextGain={incomingGain}
      nextProgress={incomingProgress}
      isLoading={playerState.track.status === 'loading'}
      positionSeconds={displayPositionSeconds}
      durationSeconds={displayDurationSeconds}
      // Disabled mid-crossfade: seekTo() still only affects the actual
      // (outgoing) source, which no longer matches what the bar is showing
      // (the incoming track's position/duration) - a tap here would compute
      // a fraction against the wrong track's duration.
      onSeekTo={pendingIncoming ? () => {} : seekTo}
      volume={volume}
      onChangeVolume={handleVolumeChange}
      controls={
        <>
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
            <LoopButton loopMode={playerState.loopMode} onPress={cycleLoopMode} />
            <ShuffleButton shuffleEnabled={playerState.shuffleEnabled} onPress={toggleShuffle} />
          </View>
        </>
      }
    />
  );

  // Covers the library scan + playback-state restore's own async window -
  // without this, the library screen would render first (empty, then
  // populated) and only jump to a restored playlist screen a beat later,
  // which reads as a flash/flicker rather than landing directly on the
  // right screen.
  if (isRestoring) {
    return (
      <View style={[styles.container, styles.restoringContainer, { backgroundColor: colors.background }]}>
        <AppTitle color={colors.text} />
      </View>
    );
  }

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
      <LibraryScreen
        colors={colors}
        rootsWithLibrary={rootsWithLibrary}
        busyRootId={busyRootId}
        onAddFolder={addFolder}
        onRescan={rescan}
        onSelectPlaylist={(root, playlist, tracksById) => setScreen({ kind: 'playlist', root, playlist, tracksById })}
        error={error}
        nowPlayingBar={nowPlayingBar}
        listStyle={styles.list}
        bannerContent={
          !SUPPORTS_DIRECTORY_PICKER && (
            <Text style={styles.warning}>
              This browser can't pick local folders. Use the self-hosted Docker server instead to browse a mounted music
              library -{' '}
              <a href={SELF_HOSTING_DOCS_URL} target="_blank" rel="noopener noreferrer" style={webLinkStyle}>
                see the setup guide
              </a>
              .
            </Text>
          )
        }
        lyricsSection={
          <LyricsFolderSection
            colors={colors}
            lyricsRoots={lyricsRoots}
            matchedTrackCount={matchedLyricsCount}
            totalTrackCount={rootsWithLibrary.reduce((sum, { tracksById }) => sum + tracksById.size, 0)}
            busyRootId={busyRootId}
            onAddLyricsFolder={addLyricsFolder}
            onRescan={rescan}
          />
        }
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
  restoringContainer: {
    justifyContent: 'center',
    opacity: 0.8,
  },
  error: {
    color: '#dc2626',
    marginTop: 12,
    maxWidth: 480,
    textAlign: 'center',
  },
  warning: {
    color: '#b45309',
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
  transportRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  // The primary play/pause/seek/skip row, styled like a real player's
  // transport bar: big circular icon buttons, evenly spaced, with
  // play/pause noticeably larger and centered.
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
  // Merged onto LibraryScreen's own base list style - see its listStyle prop's doc.
  list: {
    flex: 1,
  },
});

export default App;

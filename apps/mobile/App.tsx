/**
 * BPMix - Stage 3: playlist queue playback with loop modes and shuffle,
 * on top of Stage 2's single-track playback.
 * @format
 */

import type { FileRef, GrantedRoot, LoopMode, LyricsScope, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import {
  computeTransitionPlan,
  ensureTrackAnalyzed,
  equalPowerGain,
  errorMessage,
  formatTrackTitle,
  isMetadataCurrent,
  LYRICS_MATCHED_COUNT_SETTING_KEY,
  matchLibraryLyrics,
  PlaylistPlayer,
  realTimeForOutgoingPosition,
  scanLibraryMetadata,
  scanRoot,
  trackDisplayName,
} from '@bpmix/core';
import {
  AddFolderButton,
  AppTitle,
  CROSSFADE_ART_TRANSITION_MS,
  FolderBrowser,
  getAccentColorHex,
  HeaderActions,
  HeaderRow,
  IconLabel,
  LibraryScreen,
  LyricsFolderSection,
  lyricsScopeKey,
  MiniPlayerBar,
  NowPlayingScreen,
  PlayerControlsRow,
  RestoringScreen,
  SettingsScreen,
  TrackList,
  TURNS_PER_SONG,
  useAppSettings,
  useCoverArt,
  useDoublePressHandler,
  useFadeInOnChange,
  useNotificationCenter,
  RAPID_PLAYBACK_PATCH_DEBOUNCE_MS,
  useBackNavigation,
  usePlaybackPersistence,
  useRestoringProgress,
  useThemeColors,
  useTrackMetadata,
} from '@bpmix/ui';
import type { RootWithLibrary } from '@bpmix/ui';
import { mdiArrowLeft, mdiSubtitles } from '@mdi/js';
import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { createAudioEngine } from './src/adapters/audioEngine';
import { createCoverArtResizer } from './src/adapters/coverArtResizer';
import {
  AllFilesAccessRequiredError,
  browseDeviceStorage,
  createFileAccess,
  openAllFilesAccessSettings,
  registerRootBrowser,
  toRelativeDisplay,
} from './src/adapters/fileAccess';
import { createLibraryStore, setPriorityFileId } from './src/adapters/libraryStore';
import { useMediaSessionNotification } from './src/adapters/mediaSessionNotification';
import { MemoryOverlay } from './src/debug/MemoryOverlay';

// The overlay's 500ms poll + up to 120 re-rendered bars was noticeably
// janking the UI, especially layered on top of the Stage 4 analysis pass
// already competing for the JS thread - off by default, flip back on when
// actively chasing a memory issue.
const SHOW_MEMORY_OVERLAY = false;

const TRANSPORT_THROTTLE_MS = 300;
// How long the metadata-scan notification's "done" state stays visible
// before it dismisses itself - long enough to actually read, not so long it
// lingers as clutter once there's nothing left to do about it.
const METADATA_SCAN_AUTO_DISMISS_MS = 4000;
// Only used to construct playlistPlayer below, before any component (and
// its settings) exists - useAppSettings' own default and this must agree,
// since AppContent's crossfadeSeconds effect only re-syncs playlistPlayer
// once settings finish loading from storage.
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
/** fileId is the track a decode/playback error actually happened for, when known - see PlaylistPlayer's onError doc. Routed to the notification bell, not a one-shot setError string - see NotificationBell's doc for why. */
let reportError: (error: unknown, fileId?: string) => void = () => {};
/** Clears a fileId's "missing" flag once it decodes successfully again (e.g. a sync catches up) - bridged alongside reportError. */
let reportFileFound: (fileId: string) => void = () => {};
/** Mirrors the settings screen's volume-normalization toggle into resolveGain below - bridged the same way as reportError, since playlistPlayer is a module-level singleton built before any component (and its settings) exist. */
let volumeNormalizationEnabled = true;
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
    onError: (error, fileId) => reportError(error, fileId),
    resolveGain: async (fileId) =>
      volumeNormalizationEnabled ? ((await libraryStore.getAnalysis(fileId))?.normalizationGain ?? 1) : 1,
    onAdvance: () => notifyAdvance(),
    crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
    // Just-in-time analysis (Stage 4): a track already needed a decode for
    // playback/preload, so analyzing it here is free - no separate eager
    // batch pass over the whole library.
    onDecoded: (ref, decoded) => {
      void ensureTrackAnalyzed(libraryStore, ref, decoded, audioEngine);
      reportFileFound(ref.id);
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

type Screen =
  | { kind: 'library' }
  | { kind: 'playlist'; root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };

function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

// AppContent rerenders on every ~200ms playback poll tick (see playerState's
// own comment below) - a plain <StatusBar> inlined straight into its render
// output would re-invoke the native setStyle call that often even though
// barStyle itself only ever changes on a theme switch, confirmed on-device
// as a StatusBarModule call every single tick. Memoized so React skips
// re-rendering (and re-touching the native module) unless barStyle actually
// changed.
const AppStatusBar = memo(function AppStatusBarInner({ barStyle }: { barStyle: 'light-content' | 'dark-content' }) {
  return <StatusBar barStyle={barStyle} />;
});

function AppContent() {
  const insets = useSafeAreaInsets();
  const { settings, updateSettings, resetSettings } = useAppSettings(libraryStore);
  const colors = useThemeColors(settings.themeMode, getAccentColorHex(settings.accentColor));
  // StatusBar text needs to track the resolved theme, not the raw system
  // scheme - a user who explicitly picks Dark/AMOLED against a light-mode
  // system would otherwise get dark-on-dark, unreadable status bar text.
  const statusBarStyle = settings.themeMode === 'dark' || settings.themeMode === 'amoled' ? 'light-content' : 'dark-content';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rootsWithLibrary, setRootsWithLibrary] = useState<RootWithLibrary[]>([]);
  const [grantedRoots, setGrantedRoots] = useState<GrantedRoot[]>([]);
  const [lyricsScopes, setLyricsScopes] = useState<LyricsScope[]>([]);
  const [matchedLyricsCount, setMatchedLyricsCount] = useState<number | null>(null);
  const [busyLyricsScopeKey, setBusyLyricsScopeKey] = useState<string | null>(null);
  // Android only - true after requestRoot() throws AllFilesAccessRequiredError, so the error banner can offer a direct "Open Settings" retry instead of just describing the problem.
  const [needsAllFilesAccess, setNeedsAllFilesAccess] = useState(false);
  // Opened by tapping MiniPlayerBar's art/title area - closes back to
  // whichever screen (library or playlist) was already showing underneath.
  const [nowPlayingScreenOpen, setNowPlayingScreenOpen] = useState(false);
  // Set while FolderBrowser is open, picking a lyrics scope within this root.
  const [lyricsFolderPickerRoot, setLyricsFolderPickerRoot] = useState<GrantedRoot | null>(null);
  // Set while FolderBrowser is open picking a brand-new root (Android's
  // MANAGE_EXTERNAL_STORAGE flow only - see registerRootBrowser's doc in
  // fileAccess.android.ts; a no-op registration on Windows means this never
  // gets set there, since requestRoot() uses its own native FolderPicker).
  const [rootBrowserRequest, setRootBrowserRequest] = useState<{
    storageRootPath: string;
    storageRootDisplayName: string;
    resolve: (relativePath: string | null) => void;
  } | null>(null);
  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Everything that used to be a one-shot setError(errorMessage(err)) string
  // (playback/decode failures specifically) now goes here instead - see
  // NotificationBell's doc for why a raw error string as the *entire*
  // message wasn't good enough on its own. `error`/setError above is left
  // alone for the handful of direct-action error paths (addFolder, rescan,
  // etc.) that still want an immediate, action-adjacent inline message.
  const notificationCenter = useNotificationCenter();
  // fileIds whose most recent decode attempt failed - TrackRow reads this to
  // show a missing-file indicator instead of pretending everything's fine
  // until the user taps play and it silently does nothing.
  const [missingFileIds, setMissingFileIds] = useState<Set<string>>(new Set());
  // Drives RestoringScreen's checklist - see refresh()'s and
  // usePlaybackPersistence's onStepChange updates below.
  const { completedSteps, currentStep, hasLyricsScopes, advanceStep, setHasLyricsScopes } = useRestoringProgress();
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  const [playerState, setPlayerState] = useState<PlaylistPlayerState>(playlistPlayer.getState());
  // Cold-start restore (usePlaybackPersistence) loads the last-played track
  // and decodes it without starting playback, landing it in status
  // 'paused' - identical to a track the user actually played and then
  // paused. Gating the media-session notification on currentFileId alone
  // therefore showed it (briefly, via the native foreground-service/
  // MediaStyle machinery, which appears to tear itself back down almost
  // immediately for a session that reports isPlaying:false right from
  // its own start) on every launch, whether or not anything was ever
  // actually played. Latching true the first time real playback starts
  // (and never back to false - a later pause should still show controls)
  // distinguishes "merely restored" from "actually played this session".
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  useEffect(() => {
    if (playerState.track.status === 'playing') setHasStartedPlayback(true);
  }, [playerState.track.status]);

  // Same close-priority order as the web app (see useBackNavigation's doc) -
  // Settings, then Now Playing, then Playlist back to Library, then (nothing
  // left of ours to close) the default hardware-back behavior of exiting.
  // extraHandler runs first: it closes BPMix's Android-only folder-picker
  // overlays, which the web app has no equivalent of at all.
  useBackNavigation(
    { settingsOpen, nowPlayingOpen: nowPlayingScreenOpen, screenKind: screen.kind },
    {
      closeSettings: () => setSettingsOpen(false),
      closeNowPlaying: () => {
        setNowPlayingScreenOpen(false);
        persistPlaybackPatch({ nowPlayingOpen: false });
      },
      closePlaylist: () => setScreen({ kind: 'library' }),
    },
    () => {
      if (lyricsFolderPickerRoot) {
        setLyricsFolderPickerRoot(null);
        return true;
      }
      if (rootBrowserRequest) {
        rootBrowserRequest.resolve(null);
        setRootBrowserRequest(null);
        return true;
      }
      return false;
    },
  );

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
    // Every manual transport action funnels through here - the single
    // choke point to tell usePlaybackPersistence's on-launch restore to
    // stop trying to apply itself once the user has taken over. See
    // notifyUserTookOver's doc for the race this closes.
    notifyUserTookOver();
    return true;
  };

  useEffect(() => {
    reportError = (err, fileId) => {
      notificationCenter.addError(fileId ? `Couldn't play "${fileId.split('/').pop()}"` : 'Playback error', errorMessage(err));
      if (fileId) {
        setMissingFileIds((prev) => (prev.has(fileId) ? prev : new Set(prev).add(fileId)));
      }
    };
    reportFileFound = (fileId) => {
      setMissingFileIds((prev) => {
        if (!prev.has(fileId)) return prev;
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    };
    return () => {
      reportError = () => {};
      reportFileFound = () => {};
    };
    // notificationCenter.addError specifically - see refresh()'s identical
    // note on why the whole notificationCenter object isn't a safe dep here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationCenter.addError]);

  useEffect(() => {
    volumeNormalizationEnabled = settings.volumeNormalizationEnabled;
  }, [settings.volumeNormalizationEnabled]);

  useEffect(() => {
    playlistPlayer.setCrossfadeSeconds(settings.crossfadeSeconds);
  }, [settings.crossfadeSeconds]);

  useEffect(() => {
    registerRootBrowser(
      (storageRootPath, storageRootDisplayName) =>
        new Promise((resolve) => {
          setRootBrowserRequest({ storageRootPath, storageRootDisplayName, resolve });
        }),
    );
    return () => registerRootBrowser(null);
  }, []);

  const refresh = useCallback(async () => {
    advanceStep('listingFolders');
    const roots = await fileAccess.listGrantedRoots();
    setGrantedRoots(roots);
    advanceStep('scanningLibrary');

    // Each root's scan is isolated in its own try/catch - see
    // apps/web/src/App.tsx's refresh() for why (one bad root used to blank
    // the entire library, including every other perfectly fine root, on
    // every refresh/relaunch until removed).
    const withLibrary = (
      await Promise.all(
        roots.map(async (root) => {
          try {
            let [playlists, tracks] = await Promise.all([
              libraryStore.listPlaylists(root.id),
              libraryStore.listTracks(root.id),
            ]);
            if (playlists.length === 0 && tracks.length === 0) {
              // A root can reach listGrantedRoots() without ever going through
              // addFolder's explicit requestRoot+scanRoot flow - e.g. a
              // composite-adapter root the self-hosted server exposes just by
              // having a volume mounted (web-only today, but this keeps the
              // two refresh()s in sync rather than letting them drift). Scan
              // it now instead of silently showing an empty library until the
              // user notices and clicks Rescan themselves.
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

    // Lyrics scopes are subfolders of an already-granted root (see
    // LyricsScope's doc) - see apps/web/src/App.tsx's refresh() for the
    // identical logic/reasoning.
    const scopes = await libraryStore.getLyricsScopes();
    setLyricsScopes(scopes);
    setHasLyricsScopes(scopes.length > 0);

    if (scopes.length > 0) {
      advanceStep('scanningLyrics');
      // Optimistic starting display: last launch's exact final count,
      // shown immediately instead of null/"Matching lyrics…" - the pass
      // below only ever ticks it down (via onAnomaly) as it actually finds
      // a track without a match, then snaps to the exact true count and
      // persists it as next launch's baseline once done (onSettled). A
      // library that hasn't changed since last launch (the common case)
      // never visibly moves at all.
      const lastKnownCount = await libraryStore.getSetting(LYRICS_MATCHED_COUNT_SETTING_KEY);
      setMatchedLyricsCount(lastKnownCount != null ? Number(lastKnownCount) : null);
      const allTracks = withLibrary.flatMap(({ tracksById }) => [...tracksById.values()]);
      // Idle-chunked, same reasoning as scanLibraryMetadata below - matching
      // every track in the library against every .lrc candidate is real
      // synchronous work that shouldn't run straight through and compete
      // with whatever else is on the JS thread. Fire-and-forget: the
      // restoring track's own assignment is already resolved separately
      // (see usePlaybackPersistence/ensureLyricsAssignment), so nothing here
      // needs to be awaited before refresh() returns.
      void matchLibraryLyrics(fileAccess, libraryStore, scopes, allTracks, {
        onProgress: (matchedCount) => {
          // Only drives the display for a first-ever run (no baseline to
          // start optimistic from yet) - once there's a baseline, onAnomaly/
          // onSettled below own the display so it doesn't jump back down to
          // a small live-counted number and re-climb every launch.
          if (lastKnownCount == null) setMatchedLyricsCount(matchedCount);
        },
        onAnomaly: () => {
          if (lastKnownCount != null) setMatchedLyricsCount((prev) => (prev == null ? null : Math.max(0, prev - 1)));
        },
        onSettled: (matchedCount) => {
          setMatchedLyricsCount(matchedCount);
          void libraryStore.putSetting(LYRICS_MATCHED_COUNT_SETTING_KEY, String(matchedCount));
        },
        getPriorityFileIds: () => {
          const state = playlistPlayer.getState();
          const nextFileId = playlistPlayer.getNextFileId();
          return [state.currentFileId, nextFileId].filter((id): id is string => id != null);
        },
      }).catch((err) => setError(errorMessage(err)));
    } else {
      setMatchedLyricsCount(null);
    }
    // Fire-and-forget: fills in real titles/artists as it goes (each row's
    // useTrackMetadata retry-polls the store), rather than blocking the
    // library screen on reading every file's tag bytes up front. Cheap to
    // call again on every refresh - already-fresh tracks are skipped
    // without a re-read (see scanLibraryMetadata/isMetadataFresh).
    // scanLibraryMetadata itself chunks its work against real idle time
    // (requestIdle, backed by requestIdleCallback) rather than running
    // straight through - reading/parsing tag bytes is real synchronous JS
    // work (there's no worker-thread equivalent available here; RN's JS
    // environment is single-threaded), so it only touches the JS thread
    // during actual idle gaps instead of competing with whatever brought
    // the user to this screen. No InteractionManager.runAfterInteractions
    // wrapper needed here anymore - that API is deprecated on this RN
    // version, and requestIdle already defers past the current interaction
    // on its own.
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
      // The one real "ongoing background operation" worth its own
      // persistent notification row - this can run for a while on a large
      // stale-parser-version rescan, and previously had no visible status
      // anywhere at all.
      onProgress: ({ index, total, skipped }) => {
        const done = index + 1 >= total;
        // Skipped tracks don't otherwise update the notification (they're
        // already up to date - no point re-rendering the row for each one),
        // but the very last track always has to, skipped or not - otherwise
        // a scan whose tail happens to be already-fresh tracks never fires
        // the update that would mark this notification done, and it's left
        // permanently showing its last real progress count.
        if (skipped && !done) return;
        notificationCenter.upsertProgress('metadata-scan', 'Scanning track metadata', index + 1, total, done);
        // A finished background scan doesn't need a manual dismiss - leave
        // the "done" state on screen just long enough to actually read it.
        if (done) setTimeout(() => notificationCenter.dismiss('metadata-scan'), METADATA_SCAN_AUTO_DISMISS_MS);
      },
    });

    // The now-playing playlist's .m3u8 may have been rescanned (this
    // refresh() call itself, a manual "Rescan", or Syncthing dropping in a
    // new file) since playback started - reconcile PlaylistPlayer's
    // running order against whatever this fresh scan found instead of
    // leaving it stale until the user happens to reopen the playlist (see
    // reconcilePlaylist's doc for why a plain setPlaylist() reload isn't
    // used here - it would restart shuffle/position bookkeeping).
    const nowPlayingPlaylistId = playlistPlayer.getCurrentPlaylistId();
    if (nowPlayingPlaylistId) {
      for (const { playlists, tracksById } of withLibrary) {
        const nowPlayingPlaylist = playlists.find((p) => p.id === nowPlayingPlaylistId);
        if (nowPlayingPlaylist) {
          playlistPlayer.reconcilePlaylist(nowPlayingPlaylist.trackFileIds);
          activeTracksById = tracksById;
          setPlayerState(playlistPlayer.getState());
          persistPlaybackPatch({ shuffleOrder: playlistPlayer.getShuffleOrder() });
          break;
        }
      }
    }

    return withLibrary;
    // notificationCenter.upsertProgress specifically - see the identical
    // note on this in apps/web/src/App.tsx's refresh().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationCenter.upsertProgress]);

  const { isRestoring, persistPlaybackPatch, persistPositionIfDue, notifyUserTookOver } = usePlaybackPersistence({
    fileAccess,
    libraryStore,
    playlistPlayer,
    refresh,
    setPlayerState,
    setActiveTracksById: (tracksById) => {
      activeTracksById = tracksById;
    },
    onRestoreScreen: (root, playlist, tracksById, nowPlayingOpen) => {
      setScreen({ kind: 'playlist', root, playlist, tracksById });
      if (nowPlayingOpen) setNowPlayingScreenOpen(true);
    },
    onError: (err) => setError(errorMessage(err)),
    onStepChange: advanceStep,
    onLyricsScopesKnown: (scopes) => {
      setLyricsScopes(scopes);
      setHasLyricsScopes(scopes.length > 0);
    },
  });

  // Routes BPMix's launcher shortcuts (AndroidManifest.xml's intent-filter +
  // res/xml/shortcuts.xml, both "bpmix://<path>") to the matching screen -
  // "library" and "now-playing" only. No shortcut for Settings (always one
  // gear tap away regardless of screen) or an individual playlist (a
  // playlist has no stable identity a static shortcut could target other
  // than "whichever one happens to already be loaded", which is already
  // what the ordinary cold-start restore above does on its own).
  const applyDeepLink = useCallback((url: string) => {
    const path = url.replace(/^bpmix:\/\//, '').split(/[/?#]/)[0];
    if (path === 'library') {
      setScreen({ kind: 'library' });
      setNowPlayingScreenOpen(false);
      setSettingsOpen(false);
    } else if (path === 'now-playing') {
      setNowPlayingScreenOpen(true);
      setSettingsOpen(false);
    }
  }, []);

  useEffect(() => {
    // Warm start: the app is already running (singleTask launchMode reuses
    // the Activity) and the user taps a shortcut again - MainActivity's
    // onNewIntent hands this to RN's Linking module as a 'url' event.
    const subscription = Linking.addEventListener('url', ({ url }) => applyDeepLink(url));
    return () => subscription.remove();
  }, [applyDeepLink]);

  useEffect(() => {
    // Cold start: only once the restore screen's own async window (scanning
    // the last-played root/playlist) has settled, so a shortcut tap doesn't
    // get silently overwritten the moment that restore finishes right after
    // it. isRestoring flips true -> false exactly once per launch.
    if (isRestoring) return;
    let cancelled = false;
    void Linking.getInitialURL().then((url) => {
      if (!cancelled && url) applyDeepLink(url);
    });
    return () => {
      cancelled = true;
    };
  }, [isRestoring, applyDeepLink]);

  useEffect(() => {
    notifyAdvance = () => {
      const state = playlistPlayer.getState();
      setPlayerState(state);
      // Covers every advance not already handled at its own call site: a
      // crossfade completing and a track ending naturally both change
      // currentFileId without going through goNext/goPrevious.
      if (state.currentFileId) {
        // Also re-persists shuffleOrder here, not just on the shuffle toggle
        // itself - maybeReshuffleForLoopContinuation can silently regenerate
        // it mid-playback (loop='all' wrapping past the last track), and
        // this fires on every advance regardless of what triggered it.
        persistPlaybackPatch({
          currentTrackFileId: state.currentFileId,
          positionSeconds: state.track.positionSeconds,
          shuffleOrder: playlistPlayer.getShuffleOrder(),
        });
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
    setNeedsAllFilesAccess(false);
    try {
      const root = await fileAccess.requestRoot();
      if (!root) return; // user cancelled the picker
      setBusyRootId(root.id);
      await scanRoot(fileAccess, libraryStore, root.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof AllFilesAccessRequiredError) {
        setNeedsAllFilesAccess(true);
      }
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
        setError(errorMessage(err));
      } finally {
        setBusyRootId(null);
      }
    },
    [refresh],
  );

  const removeRoot = useCallback(
    async (rootId: string) => {
      setError(null);
      try {
        await fileAccess.revokeRoot(rootId);
        await refresh();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refresh],
  );

  // Android (MANAGE_EXTERNAL_STORAGE): browses the whole of external storage,
  // same as Add Folder does - there's no per-folder OS grant to confine a
  // lyrics location to a subfolder of an already-added root, so a lyrics
  // folder can sit right next to (not just inside) a music one.
  // Windows/web: browseDeviceStorage() always resolves null there (no
  // unrestricted-storage equivalent), so this falls back to FolderBrowser
  // over an already-granted root instead of requesting a brand-new one -
  // see LyricsScope's doc for why, and apps/web/src/App.tsx's
  // addLyricsFolder for the identical fallback reasoning/v1 scope note
  // (first granted root only, no chooser yet).
  const addLyricsFolder = useCallback(async () => {
    setError(null);
    const browsed = await browseDeviceStorage();
    if (browsed) {
      try {
        await libraryStore.addLyricsScope({ rootId: browsed.path, relativePath: '' });
        await refresh();
      } catch (err) {
        setError(errorMessage(err));
      }
      return;
    }
    const root = grantedRoots[0];
    if (!root) {
      setError('Add a music folder first - a lyrics folder is picked as a subfolder of one you already granted.');
      return;
    }
    setLyricsFolderPickerRoot(root);
  }, [grantedRoots, refresh]);

  const handleLyricsFolderPicked = useCallback(
    async (relativePath: string) => {
      const root = lyricsFolderPickerRoot;
      setLyricsFolderPickerRoot(null);
      if (!root) return;
      setError(null);
      try {
        await libraryStore.addLyricsScope({ rootId: root.id, relativePath });
        await refresh();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [lyricsFolderPickerRoot, refresh],
  );

  const rescanLyricsScope = useCallback(
    async (rootId: string, relativePath: string) => {
      setError(null);
      setBusyLyricsScopeKey(lyricsScopeKey({ rootId, relativePath }));
      try {
        await refresh();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyLyricsScopeKey(null);
      }
    },
    [refresh],
  );

  const removeLyricsScope = useCallback(
    async (rootId: string, relativePath: string) => {
      setError(null);
      try {
        await libraryStore.removeLyricsScope(rootId, relativePath);
        await refresh();
      } catch (err) {
        setError(errorMessage(err));
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
    persistPlaybackPatch({ shuffleEnabled: nextEnabled, shuffleOrder: playlistPlayer.getShuffleOrder() });
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
      // Debounced: VolumeSlider calls this on every drag touch-move tick
      // (deliberately, so the audible volume itself has no lag), and
      // hitting the store that often was visibly janking the drag itself.
      persistPlaybackPatch({ volume: value }, { debounceMs: RAPID_PLAYBACK_PATCH_DEBOUNCE_MS });
    },
    [persistPlaybackPatch],
  );

  const nowPlayingTrack = playerState.currentFileId ? activeTracksById.get(playerState.currentFileId) : undefined;

  // Keeps the now-playing track's own metadata/lyrics-assignment/cover-art
  // reads ahead of whatever backlog of unrelated TrackRow-driven reads is
  // sitting in Android's serialized SQLite queue (see setPriorityFileId's
  // doc in libraryStore.android.ts) - a no-op on Windows, which has no such
  // queue to reorder.
  useEffect(() => {
    setPriorityFileId(playerState.currentFileId);
  }, [playerState.currentFileId]);

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
      // duration (a manual skip's MANUAL_SKIP_CROSSFADE_SECONDS is much
      // shorter than the natural end-of-track crossfadeSeconds default
      // below), not a static preview of a future one.
      return { fadeStartSeconds: 0, fadeDurationSeconds: pendingIncoming.fadeDurationSeconds, incomingStartSeconds: 0 };
    }
    if (playerState.track.durationSeconds <= 0) return null;
    return computeTransitionPlan(playerState.track.durationSeconds, settings.crossfadeSeconds);
  }, [pendingIncoming, playerState.track.durationSeconds, settings.crossfadeSeconds]);

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

  // isLoadingForPlayback, not the raw status==='loading' - the latter is
  // also true for the on-launch restore's silent, non-autoplaying decode
  // (see PlaylistPlayerState.isLoadingForPlayback's doc), which shouldn't
  // show a loading bar for a track that isn't actually about to play.
  const isLoadingTrack = playerState.isLoadingForPlayback;

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
  // Feeds CrossfadeArt's disc spin (a real turns-per-second rate, not a
  // per-tick progress retarget - see CrossfadeArtProps.currentTurnsPerSecond's
  // doc): 0 while paused, TURNS_PER_SONG spread over the track's own
  // duration during ordinary playback, or - much faster - spread over
  // just the segment and duration of an in-flight rewindTo()/
  // fastForwardTo() scrub effect.
  const scrub = playerState.track.scrubbing;
  const currentTurnsPerSecond = !isPlaying
    ? 0
    : scrub
      ? (TURNS_PER_SONG * (Math.abs(scrub.fromSeconds - scrub.toSeconds) / (playerState.track.durationSeconds || 1))) / scrub.durationSeconds
      : playerState.track.durationSeconds > 0
        ? TURNS_PER_SONG / playerState.track.durationSeconds
        : 0;
  // The next slot only actually spins once a crossfade is genuinely
  // bringing it in - otherwise it hasn't started playing at all yet.
  const incomingTurnsPerSecond =
    pendingIncoming && pendingIncoming.durationSeconds > 0 ? TURNS_PER_SONG / pendingIncoming.durationSeconds : 0;

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
    // Finalizing on cleanup (not just the timeout) matters when tracks
    // change faster than CROSSFADE_ART_TRANSITION_MS apart (e.g. rapid
    // manual skips): otherwise each new effect run just cancels the
    // previous one's pending setSettledCurrentKey without ever applying
    // it, leaving the title/art permanently stuck on a stale track once
    // the skips stop, instead of catching up to whatever's actually
    // playing.
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      setSettledCurrentKey(key);
    };
    const timeout = setTimeout(finalize, CROSSFADE_ART_TRANSITION_MS);
    return () => {
      clearTimeout(timeout);
      finalize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoingTrack?.fileId]);
  useEffect(() => {
    const key = incomingTrack?.fileId ?? null;
    if (key === settledNextKey) return;
    // See the outgoing-key effect above for why finalize() also runs from
    // cleanup, not just the timeout.
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      setSettledNextKey(key);
    };
    const timeout = setTimeout(finalize, CROSSFADE_ART_TRANSITION_MS);
    return () => {
      clearTimeout(timeout);
      finalize();
    };
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

  const currentTitle = settledCurrentTrack ? formatTrackTitle(settledCurrentMetadata, settledCurrentTrack) : playerState.currentFileId;
  const currentName = settledCurrentTrack ? settledCurrentMetadata?.title || trackDisplayName(settledCurrentTrack) : (playerState.currentFileId ?? '');
  const currentArtist = settledCurrentMetadata?.artists.join(', ') || null;

  useMediaSessionNotification(
    playerState.currentFileId && hasStartedPlayback
      ? {
          title: currentName,
          artist: currentArtist,
          album: settledCurrentMetadata?.album ?? null,
          artworkUri: outgoingCoverArt,
          isPlaying: playerState.track.status === 'playing',
          positionSeconds: displayPositionSeconds,
          durationSeconds: displayDurationSeconds,
        }
      : null,
    {
      onPlayPause: togglePause,
      onNext: () => void goNext(),
      onPrevious: () => void goPrevious(),
      onSeekTo: seekTo,
    },
  );

  const miniPlayerBar = playerState.currentFileId && (
    <MiniPlayerBar
      colors={colors}
      title={currentName}
      artist={currentArtist}
      artUri={outgoingCoverArt}
      isPlaying={playerState.track.status === 'playing'}
      positionSeconds={displayPositionSeconds}
      durationSeconds={displayDurationSeconds}
      onPress={() => {
        setNowPlayingScreenOpen(true);
        persistPlaybackPatch({ nowPlayingOpen: true });
      }}
      onPlayPause={togglePause}
      onNext={handleNextPress}
      onPrevious={handlePreviousPress}
    />
  );

  const nowPlayingScreen = nowPlayingScreenOpen && playerState.currentFileId && (
    // zIndex here must beat HeaderRow's own (1, see its doc) - without an
    // explicit, higher one, the playlist/library screen underneath's own
    // HeaderRow (its back-row title + NotificationBell) painted ABOVE this
    // whole overlay despite being mounted earlier: a nested descendant's
    // zIndex doesn't just win among its own siblings on this RN/Fabric
    // version, it also outranks an ancestor-level sibling with no zIndex of
    // its own - confirmed on-device as two overlapping header rows/bells
    // ("Playlist: In Order" bleeding through "Now Playing"'s own header),
    // while everything below the header (screenArea's TrackList, no zIndex
    // of its own) stayed correctly hidden beneath this overlay as expected.
    <View style={[StyleSheet.absoluteFill, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.background, zIndex: 10 }]}>
      <NowPlayingScreen
        colors={colors}
        onClose={() => {
          setNowPlayingScreenOpen(false);
          persistPlaybackPatch({ nowPlayingOpen: false });
        }}
        title={currentTitle ?? ''}
        upNextTitle={settledNextTrack ? formatTrackTitle(settledNextMetadata, settledNextTrack) : null}
        nowPlayingOpacity={nowPlayingOpacity}
        upNextOpacity={upNextOpacity}
        currentTrackKey={outgoingTrack?.fileId ?? null}
        currentArtUri={outgoingCoverArt}
        currentGain={outgoingGain}
        currentProgress={outgoingProgress}
        currentTurnsPerSecond={currentTurnsPerSecond}
        nextTrackKey={incomingTrack?.fileId ?? null}
        nextArtUri={incomingCoverArt}
        nextGain={incomingGain}
        nextProgress={incomingProgress}
        nextTurnsPerSecond={incomingTurnsPerSecond}
        isLoading={isLoadingTrack}
        positionSeconds={displayPositionSeconds}
        durationSeconds={displayDurationSeconds}
        scrubbing={scrub}
        // Disabled mid-crossfade: seekTo() still only affects the actual
        // (outgoing) source, which no longer matches what the bar is showing
        // (the incoming track's position/duration) - a tap here would compute
        // a fraction against the wrong track's duration.
        onSeekTo={pendingIncoming ? () => {} : seekTo}
        fileAccess={fileAccess}
        libraryStore={libraryStore}
        lyricsScopes={lyricsScopes}
        headerRight={<HeaderActions colors={colors} center={notificationCenter} onOpenSettings={() => setSettingsOpen(true)} />}
        controls={
          // Disabled mid-scrub: a rewindTo()/fastForwardTo() effect already tears down (and, for fastForwardTo, recreates) the source once - stacking a second transport action on top of it before it settles risks the same rapid-fire native-source-churn crash the effect itself is built to avoid.
          <PlayerControlsRow
            colors={colors}
            loopMode={playerState.loopMode}
            onCycleLoop={cycleLoopMode}
            shuffleEnabled={playerState.shuffleEnabled}
            onToggleShuffle={toggleShuffle}
            volume={volume}
            onChangeVolume={handleVolumeChange}
            isPlaying={playerState.track.status === 'playing'}
            onTogglePlayPause={togglePause}
            onPrevious={handlePreviousPress}
            onNext={handleNextPress}
            disabled={!!scrub}
          />
        }
      />
    </View>
  );

  // Higher zIndex than nowPlayingScreen's (10, above) - opened from a header
  // button reachable on every screen INCLUDING Now Playing, so it has to be
  // able to sit on top of that overlay too, not just the library/playlist
  // screen underneath both.
  const settingsScreen = settingsOpen && (
    <View style={[StyleSheet.absoluteFill, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.background, zIndex: 20 }]}>
      <SettingsScreen
        colors={colors}
        settings={settings}
        onUpdateSettings={updateSettings}
        onResetSettings={resetSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </View>
  );

  // Covers the library scan + playback-state restore's own async window -
  // without this, the library screen would render first (empty, then
  // populated) and only jump to a restored playlist screen a beat later,
  // which reads as a flash/flicker rather than landing directly on the
  // right screen.
  if (isRestoring) {
    return (
      <>
        <AppStatusBar barStyle={statusBarStyle} />
        <RestoringScreen
          colors={colors}
          paddingTop={insets.top}
          completedSteps={completedSteps}
          currentStep={currentStep}
          hasLyricsScopes={hasLyricsScopes}
        />
      </>
    );
  }

  // busyRootId is also set for a brand-new root while it's being scanned,
  // before it exists in rootsWithLibrary - the "Scanning…" link next to an
  // already-listed root's name doesn't cover that case, so this is the only
  // signal available while a first-time Add Folder scan is running.
  const isAddingFolder = busyRootId !== null && !rootsWithLibrary.some(({ root }) => root.id === busyRootId);

  if (rootBrowserRequest) {
    return (
      <>
        <AppStatusBar barStyle={statusBarStyle} />
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.background }]}>
          <FolderBrowser
            colors={colors}
            fileAccess={fileAccess}
            rootId={rootBrowserRequest.storageRootPath}
            rootDisplayName={rootBrowserRequest.storageRootDisplayName}
            existingRoots={grantedRoots.map((root) => ({ path: root.id, displayName: root.displayName }))}
            onSelect={(relativePath) => {
              rootBrowserRequest.resolve(relativePath);
              setRootBrowserRequest(null);
            }}
            onCancel={() => {
              rootBrowserRequest.resolve(null);
              setRootBrowserRequest(null);
            }}
          />
        </View>
      </>
    );
  }

  if (lyricsFolderPickerRoot) {
    return (
      <>
        <AppStatusBar barStyle={statusBarStyle} />
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.background }]}>
          <FolderBrowser
            colors={colors}
            fileAccess={fileAccess}
            rootId={lyricsFolderPickerRoot.id}
            rootDisplayName={lyricsFolderPickerRoot.displayName}
            onSelect={(relativePath) => void handleLyricsFolderPicked(relativePath)}
            onCancel={() => setLyricsFolderPickerRoot(null)}
          />
        </View>
      </>
    );
  }

  let screenContent: ReactNode;
  if (screen.kind === 'playlist') {
    const { playlist, tracksById } = screen;
    screenContent = (
      <>
        <HeaderRow
          style={styles.backRow}
          left={
            <Pressable onPress={() => setScreen({ kind: 'library' })}>
              <IconLabel path={mdiArrowLeft} text={`Playlist: ${playlist.name}`} color={colors.text} iconSize={18} textStyle={styles.backLink} />
            </Pressable>
          }
          right={<HeaderActions colors={colors} center={notificationCenter} onOpenSettings={() => setSettingsOpen(true)} />}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <TrackList
          trackFileIds={playlist.trackFileIds}
          tracksById={tracksById}
          currentFileId={playerState.currentFileId}
          isPlaying={playerState.track.status === 'playing'}
          isLoading={playerState.isLoadingForPlayback}
          textColor={colors.text}
          colors={colors}
          onPressTrack={(t) => void playFromTrack(playlist, tracksById, t)}
          libraryStore={libraryStore}
          initialNumToRender={20}
          missingFileIds={missingFileIds}
        />
      </>
    );
  } else {
    screenContent = (
      <LibraryScreen
        colors={colors}
        rootsWithLibrary={rootsWithLibrary}
        busyRootId={busyRootId}
        isAddingFolder={isAddingFolder}
        onAddFolder={addFolder}
        onRescan={rescan}
        onRemoveRoot={(rootId) => void removeRoot(rootId)}
        onSelectPlaylist={(root, playlist, tracksById) => setScreen({ kind: 'playlist', root, playlist, tracksById })}
        error={error}
        errorAction={
          needsAllFilesAccess && (
            <Pressable style={[styles.grantAccessButton, { backgroundColor: colors.accent }]} onPress={openAllFilesAccessSettings}>
              <Text style={styles.grantAccessButtonText}>Open Settings</Text>
            </Pressable>
          )
        }
        headerRight={<HeaderActions colors={colors} center={notificationCenter} onOpenSettings={() => setSettingsOpen(true)} />}
        secondaryAddButton={<AddFolderButton colors={colors} icon={mdiSubtitles} text="Add Lyrics Folder" onPress={addLyricsFolder} />}
        lyricsSection={
          <LyricsFolderSection
            colors={colors}
            scopes={lyricsScopes}
            rootDisplayName={(rootId) => grantedRoots.find((r) => r.id === rootId)?.displayName ?? toRelativeDisplay(rootId)}
            matchedTrackCount={matchedLyricsCount}
            totalTrackCount={rootsWithLibrary.reduce((sum, { tracksById }) => sum + tracksById.size, 0)}
            busyScopeKey={busyLyricsScopeKey}
            onRemoveScope={(rootId, relativePath) => void removeLyricsScope(rootId, relativePath)}
            onRescan={(rootId, relativePath) => void rescanLyricsScope(rootId, relativePath)}
          />
        }
      />
    );
  }

  return (
    <>
      <AppStatusBar barStyle={statusBarStyle} />
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.background }]}>
        {__DEV__ && SHOW_MEMORY_OVERLAY && <MemoryOverlay />}
        <View style={styles.screenArea}>{screenContent}</View>
        {miniPlayerBar}
        {nowPlayingScreen}
        {settingsScreen}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 24,
  },
  // Wraps the library/playlist content so it can flex to fill the space
  // above MiniPlayerBar/NowPlayingScreen instead of the two overlapping -
  // container itself can't grow the content because it also hosts those
  // siblings.
  screenArea: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
  },
  grantAccessButton: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  grantAccessButtonText: {
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
  },
  backLink: {
    fontSize: 18,
    fontWeight: '600',
  },
});

export default App;

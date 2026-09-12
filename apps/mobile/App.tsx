/**
 * BPMix - Stage 3: playlist queue playback with loop modes and shuffle,
 * on top of Stage 2's single-track playback.
 * @format
 */

import type { FileRef, GrantedRoot, LyricsScope, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import {
  ensureTrackAnalyzed,
  errorMessage,
  formatTrackTitle,
  logLibraryAction,
  LYRICS_MATCHED_COUNT_SETTING_KEY,
  matchLibraryLyrics,
  PlaylistPlayer,
  scanLibraryMetadata,
  scanRoot,
} from '@bpmix/core';
import {
  AppTitle,
  BackButton,
  FolderBrowser,
  FolderPickerButton,
  getAccentColorHex,
  HeaderActions,
  HeaderRow,
  LibraryScreen,
  LyricsFolderSection,
  lyricsScopeKey,
  MiniPlayerBar,
  NowPlayingScreen,
  PlayerControlsRow,
  RestoringScreen,
  SettingsScreen,
  TrackList,
  useAppSettings,
  useCrossfadePlaybackDisplay,
  useMemoryUsageLogging,
  useNotificationCenter,
  useBackNavigation,
  usePlaybackPersistence,
  usePlaylistTransport,
  useRestoringProgress,
  useThemeColors,
  useVolumeControl,
} from '@bpmix/ui';
import type { RootWithLibrary } from '@bpmix/ui';
import { mdiSubtitles } from '@mdi/js';
import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
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
/** Stable identity across renders (unlike an inline arrow assigning activeTracksById directly) so usePlaylistTransport's playFromTrack doesn't get recreated every render. */
const setActiveTracksById = (tracksById: Map<string, TrackRecord>) => {
  activeTracksById = tracksById;
};
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

  useMemoryUsageLogging(playerState.track.status !== 'idle');

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
        // A 'lyrics' root (see GrantedRoot.kind's doc) is never a music
        // library - it's a lyrics-only folder granted via addLyricsFolder's
        // own requestRoot('lyrics') call, and scanning/listing it here would
        // just show a permanently-empty "library" entry for it. Same filter
        // as apps/web/src/App.tsx's refresh().
        roots
          .filter((root) => (root.kind ?? 'library') === 'library')
          .map(async (root) => {
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
            logLibraryAction('refresh:rootFailed', { rootId: root.id, error: String(err) });
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
      }).catch((err) => {
        setError(errorMessage(err));
        logLibraryAction('matchLibraryLyrics:failed', { error: String(err) });
      });
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
    onError: (err) => {
      setError(errorMessage(err));
      logLibraryAction('playbackPersistence:failed', { error: String(err) });
    },
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

  // Double-click/double-tap invocation guarding (e.g. against opening two
  // concurrent native folder-picker prompts, observed on Windows to leave
  // the WinRT broker in a bad state and surface later as an
  // unrelated-looking "The file is in use" error during a scan) lives in
  // FolderPickerButton (packages/ui) now, not here - this is just the plain
  // pick-and-handle operation it wraps.
  const addFolder = useCallback(async () => {
    setError(null);
    setNeedsAllFilesAccess(false);
    try {
      const root = await fileAccess.requestRoot();
      if (!root) return; // user cancelled the picker
      setBusyRootId(root.id);
      await scanRoot(fileAccess, libraryStore, root.id);
      await refresh();
      logLibraryAction('addFolder', { rootId: root.id });
    } catch (err) {
      setError(errorMessage(err));
      logLibraryAction('addFolder:failed', { error: String(err) });
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
        logLibraryAction('rescan', { rootId });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('rescan:failed', { rootId, error: String(err) });
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
        logLibraryAction('removeRoot', { rootId });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('removeRoot:failed', { rootId, error: String(err) });
      }
    },
    [refresh],
  );

  // Android (MANAGE_EXTERNAL_STORAGE): browses the whole of external storage,
  // same as Add Folder does - there's no per-folder OS grant to confine a
  // lyrics location to a subfolder of an already-added root, so a lyrics
  // folder can sit right next to (not just inside) a music one.
  // Windows: browseDeviceStorage() always resolves null there (no
  // unrestricted-storage equivalent), so this falls through to a real,
  // independent OS directory picker (requestRoot('lyrics')) instead - full
  // parity with web's addLyricsFolder, which does the same. The old
  // subfolder-of-an-already-granted-root fallback only existed because every
  // granted root used to be unconditionally scanned as a music library
  // (refresh() above); GrantedRoot.kind now lets refresh() skip a
  // lyrics-only root, so this can just grant its own root like addFolder
  // does - see GrantedRoot.kind's doc.
  const addLyricsFolder = useCallback(async () => {
    setError(null);
    try {
      const browsed = await browseDeviceStorage();
      if (browsed) {
        await libraryStore.addLyricsScope({ rootId: browsed.path, relativePath: '' });
        await refresh();
        logLibraryAction('addLyricsFolder', { rootId: browsed.path });
        return;
      }
      const root = await fileAccess.requestRoot('lyrics');
      if (!root) return; // user cancelled the picker
      await libraryStore.addLyricsScope({ rootId: root.id, relativePath: '' });
      await refresh();
      logLibraryAction('addLyricsFolder', { rootId: root.id });
    } catch (err) {
      setError(errorMessage(err));
      logLibraryAction('addLyricsFolder:failed', { error: String(err) });
    }
  }, [refresh]);

  const rescanLyricsScope = useCallback(
    async (rootId: string, relativePath: string) => {
      setError(null);
      setBusyLyricsScopeKey(lyricsScopeKey({ rootId, relativePath }));
      try {
        await refresh();
        logLibraryAction('rescanLyricsScope', { rootId, relativePath });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('rescanLyricsScope:failed', { rootId, relativePath, error: String(err) });
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
        // A lyrics-only root (granted via addLyricsFolder's own
        // requestRoot('lyrics') - see GrantedRoot.kind's doc) has no other
        // reason to stay granted once its last scope is removed - revoke it
        // too rather than leave an orphaned grant sitting around forever
        // with nothing in the UI ever referencing it again. A root still
        // used for music, or still holding another lyrics scope, is left
        // alone. Same logic as apps/web/src/App.tsx's removeLyricsScope.
        const isLibraryRoot = grantedRoots.some((r) => r.id === rootId && (r.kind ?? 'library') === 'library');
        const remainingScopes = await libraryStore.getLyricsScopes();
        if (!isLibraryRoot && !remainingScopes.some((s) => s.rootId === rootId)) {
          await fileAccess.revokeRoot(rootId);
        }
        await refresh();
        logLibraryAction('removeLyricsScope', { rootId, relativePath });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('removeLyricsScope:failed', { rootId, relativePath, error: String(err) });
      }
    },
    [refresh, grantedRoots],
  );

  const {
    playFromTrack,
    togglePause,
    seekTo,
    goNext,
    goPrevious,
    handleNextPress,
    handlePreviousPress,
    cycleLoopMode,
    toggleShuffle,
  } = usePlaylistTransport({
    playlistPlayer,
    playerState,
    persistPlaybackPatch,
    transportActionAllowed,
    setPlayerState,
    setError,
    setActiveTracksById,
  });

  const { volume, handleVolumeChange } = useVolumeControl({ playlistPlayer, libraryStore, persistPlaybackPatch });

  // Keeps the now-playing track's own metadata/lyrics-assignment/cover-art
  // reads ahead of whatever backlog of unrelated TrackRow-driven reads is
  // sitting in Android's serialized SQLite queue (see setPriorityFileId's
  // doc in libraryStore.android.ts) - a no-op on Windows, which has no such
  // queue to reorder. No web analogue (no such queue there), so this stays
  // outside useCrossfadePlaybackDisplay.
  useEffect(() => {
    setPriorityFileId(playerState.currentFileId);
  }, [playerState.currentFileId]);

  const {
    outgoingTrack,
    incomingTrack,
    outgoingCoverArt,
    incomingCoverArt,
    outgoingGain,
    incomingGain,
    outgoingProgress,
    isLoadingTrack,
    displayPositionSeconds,
    displayDurationSeconds,
    currentTurnsPerSecond,
    settledCurrentTrack,
    settledCurrentMetadata,
    settledNextTrack,
    settledNextMetadata,
    currentTitle,
    currentName,
    currentArtist,
  } = useCrossfadePlaybackDisplay({
    playlistPlayer,
    playerState,
    activeTracksById,
    libraryStore,
    crossfadeSeconds: settings.crossfadeSeconds,
  });
  // Only pendingIncoming's presence matters at the JSX call sites below
  // (deciding lyricsTrackKey/onSeekTo), not its fields - those all flow
  // through the hook's own outgoing/incoming derivation above.
  const pendingIncoming = playerState.track.pendingIncoming;

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
        lyricsTrackKey={(pendingIncoming ? incomingTrack?.fileId : outgoingTrack?.fileId) ?? null}
        currentArtUri={outgoingCoverArt}
        currentGain={outgoingGain}
        currentProgress={outgoingProgress}
        currentTurnsPerSecond={currentTurnsPerSecond}
        nextArtUri={incomingCoverArt}
        nextGain={incomingGain}
        isLoading={isLoadingTrack}
        positionSeconds={displayPositionSeconds}
        durationSeconds={displayDurationSeconds}
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

  let screenContent: ReactNode;
  if (screen.kind === 'playlist') {
    const { playlist, tracksById } = screen;
    screenContent = (
      <>
        <HeaderRow
          style={styles.backRow}
          left={<BackButton text={`Playlist: ${playlist.name}`} color={colors.text} onPress={() => setScreen({ kind: 'library' })} />}
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
        secondaryAddButton={
          <FolderPickerButton colors={colors} icon={mdiSubtitles} text="Add Lyrics Folder" onPress={addLyricsFolder} />
        }
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
});

export default App;

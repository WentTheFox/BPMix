import type { FileRef, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import {
  createBackgroundFileAccess,
  addError,
  createStore,
  LivePlayback,
  startPlaybackTicker,
  selectPlayingContext,
  fileFoundReported,
  fileMissingReported,
  refreshLibrary,
  DEFAULT_CROSSFADE_SECONDS,
  ensureTrackAnalyzed,
  errorMessage,
  formatTrackTitle,
  logLibraryAction,
  PlaylistPlayer,
  scanLibraryMetadataQueued,
  trackDisplayName,
} from '@bpmix/core';
import {
  AddToPlaylistDialog,
  BackButton,
  ConfirmDialog,
  CreatePlaylistScreen,
  EditPlaylistFileScreen,
  FolderBrowser,
  FolderPickerButton,
  HeaderActions,
  getAccentColorHex,
  HeaderRow,
  LibraryScreen,
  LocateMissingFileScreen,
  LyricsFolderSection,
  MiniPlayerBar,
  MultiPaneLayout,
  NowPlayingScreen,
  PlayerControlsRow,
  RestoringScreen,
  ScreenLayer,
  SettingsScreen,
  TrackList,
  ExternalConnectionsScreen,
  useAppSettings,
  useCrossfadePlaybackDisplay,
  useLastFmConnection,
  useLastFmScrobbling,
  useLibraryRootActions,
  useOpenPlaylistMetadataScan,
  useMemoryUsageLogging,
  useMissingTrackRelocation,
  useNotificationCenter,
  useTaskNotifications,
  useBackNavigation,
  useHasLyrics,
  usePlaybackPersistence,
  usePlaylistTransport,
  useRestoringProgress,
  useThemeColors,
  useAppDispatch,
  useAppSelector,
  useLivePlayerState,
  useLibrary,
  useNavigation,
  usePlaylistScreen,
  useViewportTier,
  useVolumeControl,
  StoreProvider,
} from '@bpmix/ui';
import { mdiSubtitles } from '@mdi/js';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DimensionValue } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createAudioEngine } from './adapters/audioEngine';
import { createCoverArtResizer } from './adapters/coverArtResizer';
import { createCompositeFileAccess, isServerBackendAvailable, isServerRootId } from './adapters/fileAccess.composite';
import { createLibraryStore } from './adapters/libraryStore';
import { useMediaSessionNotification } from './adapters/mediaSessionNotification';
import { isRunningInstalled, promptInstall, usePwaInstallAvailable } from './adapters/pwaInstall';

const TRANSPORT_THROTTLE_MS = 300;

// File System Access API is Chromium-only (no Firefox/Safari support as of
// this writing) - the composite adapter's server roots (Docker self-host)
// work regardless, but "Add Folder" itself needs this to pick local folders.
const SUPPORTS_DIRECTORY_PICKER = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
const SELF_HOSTING_DOCS_URL = 'https://github.com/WentTheFox/BPMix/blob/main/apps/server/README.md';
/** LibraryStore.getSetting/putSetting key for whether the user dismissed the "install this app" onboarding row - see the installOnboarding block below. */
const INSTALL_ONBOARDING_DISMISSED_SETTING_KEY = 'installOnboardingDismissed';
// A real DOM <a>, not an RN Text/Pressable - react-native-web's StyleSheet
// objects aren't meant for raw DOM elements, so this is a plain CSS object.
const webLinkStyle: CSSProperties = { color: 'inherit', textDecoration: 'underline', fontWeight: 600 };

const fileAccess = createCompositeFileAccess();
// A stable singleton (not re-wrapped per call) - scanAllLyricsScopes's scan
// cache is keyed by FileAccess instance identity, and reusing the same
// wrapper is what keeps every background caller (matchLibraryLyrics,
// scanLibraryMetadata) hitting that cache instead of missing it every time.
// See createBackgroundFileAccess's doc for why background passes need this
// at all: requestPermission() can't be called off a non-gesture code path.
const backgroundFileAccess = createBackgroundFileAccess(fileAccess);
const libraryStore = createLibraryStore();
// See apps/mobile/App.tsx's identical initialPlaybackStatePromise for why
// this is kicked off here, at module load, rather than inside a hook.
const initialPlaybackStatePromise = libraryStore.getPlaybackState();
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

/** Stand-in when nothing's playing yet, so lookups don't need a null check. */
const NO_TRACKS: ReadonlyMap<string, TrackRecord> = new Map();
// Bridged in on mount, same pattern as the other bridges - lets PlaylistPlayer push
// an immediate re-render right when position changes outside a manual UI
// action (a crossfade completing, or a natural end auto-advancing), instead
// of the "now playing" display waiting on the next ~200ms poll tick to
// notice (see PlaylistPlayer's onAdvance doc).
let notifyAdvance: () => void = () => {};

const playlistPlayer = new PlaylistPlayer(
  audioEngine,
  (fileId) => {
    // PlaylistPlayer resolves a fileId to a FileRef through the playing playlist's tracks, read
    // synchronously from the store (so it's current from the very first decode).
    const track = selectPlayingContext(store.getState())?.tracksById.get(fileId);
    if (!track) throw new Error(`Unknown track ${fileId}`);
    return trackToFileRef(track);
  },
  {
    onError: (error, fileId) => reportPlaybackError(error, fileId),
    resolveGain: async (fileId) =>
      store.getState().settings.values.volumeNormalizationEnabled ? ((await libraryStore.getAnalysis(fileId))?.normalizationGain ?? 1) : 1,
    onAdvance: () => notifyAdvance(),
    crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
    // Just-in-time analysis (Stage 4): a track already needed a decode for
    // playback/preload, so analyzing it here is free - no separate eager
    // batch pass over the whole library.
    onDecoded: (ref, decoded) => {
      void ensureTrackAnalyzed(libraryStore, ref, decoded);
      store.dispatch(fileFoundReported(ref.id));
    },
  },
);
// See apps/mobile/App.tsx's identical call for why.
playlistPlayer.awaitInitialVolume(initialPlaybackStatePromise.then((stored) => stored?.volume ?? 0.25));

// The player's full live state - what the UI reads (position and all) - and the
// one way to refresh it after something changed the player.
const livePlayback = new LivePlayback(playlistPlayer);
const setPlayerState = (state: PlaylistPlayerState) => livePlayback.publish(state);

// The app's single redux store. Slices migrate into it one feature at a time
// (see the store migration plan); services is what thunks/listeners may
// reach for side effects, so reducers themselves stay pure.
const store = createStore({
  fileAccess,
  libraryStore,
  audioEngine,
  playlistPlayer,
  livePlayback,
  coverArtResizer,
  appUpdateBridge: null,
  discordPresenceBridge: null,
  backgroundFileAccess,
  alwaysRescanRoot: isServerRootId,
  now: Date.now,
});

/** fileId is the track a decode/playback error actually happened for, when known - see PlaylistPlayer's onError doc. Routed to the notification bell, not the error banner - see NotificationBell's doc for why. */
function reportPlaybackError(error: unknown, fileId?: string): void {
  store.dispatch(addError(fileId ? `Couldn't play "${fileId.split('/').pop()}"` : 'Playback error', errorMessage(error)));
  if (fileId) store.dispatch(fileMissingReported(fileId));
}

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

function App() {
  return (
    <StoreProvider store={store}>
      <AppContent />
    </StoreProvider>
  );
}

function AppContent() {
  const { settings, updateSettings, resetSettings } = useAppSettings();
  const colors = useThemeColors(settings.themeMode, getAccentColorHex(settings.accentColor));
  // See useViewportTier's doc - 'narrow' keeps today's single-screen-plus-
  // overlay behavior below; 'medium'/'wide' switch to MultiPaneLayout.
  const tier = useViewportTier();
  // Overlay visibility and the create-playlist flow live in the store's
  // navigation slice (see useNavigation); the lyrics editor/picker flags are
  // lifted out of LyricsSection so the header lyrics menu, a sibling of
  // NowPlayingScreen rather than a descendant, can open them.
  const {
    settingsOpen,
    externalConnectionsOpen,
    nowPlayingOpen: nowPlayingScreenOpen,
    lyricsEditorOpen,
    lyricsPickerOpen,
    createPlaylistRootId,
    createPlaylistTarget,
    openSettings,
    closeSettings,
    openExternalConnections,
    closeExternalConnections,
    setNowPlayingOpen,
    setLyricsEditorOpen,
    setLyricsPickerOpen,
    openLyricsEditorFromMenu,
    openLyricsPickerFromMenu,
    startCreatePlaylist,
    chooseCreatePlaylistFolder,
    endCreatePlaylist,
  } = useNavigation();
  // Library data (roots, playlists, tracks, lyrics scopes, the error banner,
  // missing-file flags) lives in the store's library slice - see useLibrary.
  const {
    rootsWithLibrary,
    grantedRoots,
    isLoadingRoots,
    lyricsScopes,
    matchedLyricsCount,
    error,
    missingFileIds,
    setError,
    setLyricsScopes,
  } = useLibrary();
  const dispatch = useAppDispatch();
  // Everything that used to be a one-shot setError(errorMessage(err)) string
  // (playback/decode failures specifically) now goes here instead - see
  // NotificationBell's doc for why a raw error string as the *entire*
  // message ("A requested file or directory could not be found...") wasn't
  // good enough on its own. `error`/setError (from useLibrary) is left alone for the
  // handful of direct-action error paths (addFolder, rescan, etc.) that
  // still want an immediate, action-adjacent inline message.
  const notificationCenter = useNotificationCenter();
  // fileIds whose most recent decode attempt failed - TrackRow reads this to
  // show a missing-file indicator instead of pretending everything's fine
  // until the user taps play and it silently does nothing.
  // Onboarding: nudges the user to install BPMix as a PWA once they're
  // actually relying on a browser-granted local folder (SUPPORTS_DIRECTORY_PICKER),
  // since only an installed PWA gets Chrome's persistent File System Access
  // permissions - a plain tab always eventually needs a fresh gesture-based
  // re-grant no matter what. Deliberately skipped entirely for a self-hosted
  // Docker deployment (isServerBackendAvailable) - server-granted roots need
  // no browser permission at all, so installing wouldn't help with anything
  // here and would just be a confusing, irrelevant prompt in that mode.
  const [installOnboardingDismissed, setInstallOnboardingDismissed] = useState(true);
  const [showInstallOnboarding, setShowInstallOnboarding] = useState(false);
  const installPromptAvailable = usePwaInstallAvailable();
  // Drives the directory-picker banner below: once true, the user is already
  // on a Docker self-host, so there's nothing left to suggest they set up -
  // just note that new folders need a bind mount, without the warning color.
  const [serverBackendAvailable, setServerBackendAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void libraryStore.getSetting(INSTALL_ONBOARDING_DISMISSED_SETTING_KEY).then((dismissed) => {
      if (!cancelled) setInstallOnboardingDismissed(dismissed === '1');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (SUPPORTS_DIRECTORY_PICKER) return;
    let cancelled = false;
    void isServerBackendAvailable().then((serverAvailable) => {
      if (!cancelled) setServerBackendAvailable(serverAvailable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!SUPPORTS_DIRECTORY_PICKER || installOnboardingDismissed || !installPromptAvailable || grantedRoots.length === 0 || isRunningInstalled()) {
      setShowInstallOnboarding(false);
      return;
    }
    let cancelled = false;
    void isServerBackendAvailable().then((serverAvailable) => {
      if (!cancelled) setShowInstallOnboarding(!serverAvailable);
    });
    return () => {
      cancelled = true;
    };
  }, [installOnboardingDismissed, installPromptAvailable, grantedRoots.length]);

  const dismissInstallOnboarding = useCallback(() => {
    setInstallOnboardingDismissed(true);
    void libraryStore.putSetting(INSTALL_ONBOARDING_DISMISSED_SETTING_KEY, '1');
  }, []);
  // Drives RestoringScreen's checklist - see refresh()'s and
  // usePlaybackPersistence's onStepChange updates below.
  const { completedSteps, currentStep, hasLyricsScopes, advanceStep, setHasLyricsScopes } = useRestoringProgress();
  // The open playlist screen, the playing playlist, and the edit/add-to-
  // playlist targets live in the store's navigation slice - see
  // usePlaylistScreen. Opening/closing doesn't persist "last opened" itself;
  // the call sites do (persistOpenedPlaylist below).
  const {
    screen,
    playingContext,
    editingPlaylistFile,
    addToPlaylistTrack,
    isFindingUnplaylisted,
    openLibrary,
    openPlaylist,
    markOpenPlaylistPlaying,
    restore: restorePlaylistScreen,
    setPlayingContext,
    setEditingPlaylistFile,
    setAddToPlaylistTrack,
    showNowPlaying,
    showUnplaylisted,
    moveTracks,
    removeTracks,
    addPendingTrackToPlaylist,
  } = usePlaylistScreen();
  const playerState = useLivePlayerState(livePlayback);
  // Distinguishes "merely restored on launch" from "actually played this
  // session" - see the mobile app's identical hasStartedPlayback for why:
  // gating the media session on currentFileId alone would surface OS/
  // browser media controls (and a playbackState) on every page load,
  // whether or not anything was ever actually played, since the restore
  // path decodes the last track silently without autoplaying it.
  const hasStartedPlayback = useAppSelector((state) => state.playback.hasStartedPlayback);

  useMemoryUsageLogging(playerState.track.status !== 'idle');

  // Same close-priority order as the mobile app (see useBackNavigation's
  // doc) - Settings, then Now Playing, then Playlist back to Library, then
  // (nothing left of ours to close) the browser's own back behavior of
  // leaving the page. nowPlayingOpen is forced false here once Now Playing
  // is docked (medium/wide tier, see MultiPaneLayout) rather than an
  // overlay - there's nothing for back/escape to "close" about a pane
  // that's permanently visible, so it's simply excluded from this
  // priority stack in that case.
  useBackNavigation(
    { externalConnectionsOpen, settingsOpen, nowPlayingOpen: tier === 'narrow' && nowPlayingScreenOpen, screenKind: screen.kind },
    {
      closeExternalConnections,
      closeSettings,
      closeNowPlaying: () => {
        setNowPlayingOpen(false);
        persistPlaybackPatch({ nowPlayingOpen: false });
      },
      closePlaylist: () => {
        openLibrary();
        persistPlaybackPatch({ openedPlaylistId: null, openedRootId: null });
      },
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

  // Loading lives in the refreshLibrary thunk (see @bpmix/core's
  // store/library); the callbacks bridge what this component still owns: the
  // restore checklist, and the playback state/persistence that a reconciled
  // now-playing playlist feeds. Only `dispatch` as a dep (stable) - depending
  // on the callbacks would recreate refresh, and so retrigger
  // usePlaybackPersistence's restore effect (which depends on it).
  const refresh = useCallback(
    () =>
      dispatch(
        refreshLibrary({
          onStep: advanceStep,
          onLyricsScopesKnown: setHasLyricsScopes,
          onNowPlayingReconciled: () => {
            setPlayerState(playlistPlayer.getState());
            persistPlaybackPatch({ shuffleOrder: playlistPlayer.getShuffleOrder() });
          },
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatch],
  );

  const { isRestoring, persistPlaybackPatch, persistPositionIfDue, notifyUserTookOver } = usePlaybackPersistence({
    fileAccess,
    backgroundFileAccess,
    libraryStore,
    playlistPlayer,
    initialPlaybackStatePromise,
    refresh,
    setPlayerState,
    setPlayingContext,
    onRestoreScreen: restorePlaylistScreen,
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

  // Stage 6 lookahead (checkPreload) reuses this tick instead of a second timer.
  useEffect(
    () => startPlaybackTicker({ livePlayback, playlistPlayer, onTick: persistPositionIfDue }),
    [persistPositionIfDue],
  );

  // Double-click invocation guarding (e.g. against opening two concurrent
  // native folder-picker prompts, observed on Windows to leave the WinRT
  // broker in a bad state and surface later as an unrelated-looking "file
  // in use" error during a scan) lives in FolderPickerButton (packages/ui)
  // now, not here - this is just the plain pick-and-handle operation it
  // wraps.
  // Rescan is the one place a user explicitly asks to re-check a folder,
  // but it deliberately does NOT force past the cheap sizeBytes/lastModifiedMs
  // freshness gate here - only tracks the walk itself just found actually
  // changed (a real size/mtime diff) get re-read. An unconditional
  // forceRefresh was tried first (to also catch a same-size/same-mtime
  // content edit - see TrackMetadata.contentHash's doc) but re-hashed every
  // track in the root on every Rescan, which on a real library both wastes
  // bandwidth/CPU for files that provably didn't change and contends with
  // the folder walk itself over the same I/O - confirmed live, reported by
  // the user. That same-size/same-mtime edge case is rare enough it isn't
  // worth that cost as an automatic default; forceRefresh itself is still
  // there in scanLibraryMetadata's options for a future explicit "verify
  // everything" action if one turns out to be needed. Runs as its own
  // idle-chunked pass (fire-and-forget - onRescanned below doesn't await
  // this) with its own notification row, same pattern as refresh()'s own
  // background scanLibraryMetadata call, just scoped to the rescanned root.
  const verifyRootMetadata = useCallback(
    async (rootId: string) => {
      // Most-recently-modified first - purely a priority ordering now (the
      // freshness gate itself already limits this pass to changed tracks
      // regardless of order), but still worth keeping: on a large library
      // this pass won't necessarily finish quickly, and a track that just
      // changed is more likely to be one the user cares about seeing
      // updated first.
      const tracks = (await libraryStore.listTracks(rootId)).filter((t) => !t.missing).sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
      await scanLibraryMetadataQueued({ id: `metadata-verify-${rootId}`, label: 'Verifying track metadata' }, backgroundFileAccess, libraryStore, tracks, {
        resizer: coverArtResizer,
      });
      // Picks up any title/artist/art that actually changed.
      await refresh();
    },
    [refresh],
  );

  // A real, independent OS directory picker (requestRoot('lyrics')) rather
  // than FolderBrowser over an already-granted music root - the old
  // subfolder-only flow existed only because every granted root used to be
  // unconditionally scanned as a music library (refresh() below), which
  // would've left a phantom empty "library" entry for a lyrics-only root.
  // GrantedRoot.kind now lets refresh() skip exactly that, so this can just
  // grant its own root like addFolder does.
  const {
    addFolder,
    rescan,
    removeRoot,
    addLyricsFolder,
    rescanLyricsScope,
    removeLyricsScope,
    busyRootId,
    busyLyricsScopeKey,
    isRootScanning,
  } = useLibraryRootActions({
      fileAccess,
      libraryStore,
      grantedRoots,
      refresh,
      setError,
      onUnresolvedEntries: (title, detail) => notificationCenter.addError(title, detail),
      onRescanned: (rootId) => void verifyRootMetadata(rootId),
    });

  useTaskNotifications();

  useOpenPlaylistMetadataScan({ fileAccess: backgroundFileAccess, libraryStore, resizer: coverArtResizer, screen });

  const missingTrackRelocation = useMissingTrackRelocation({ fileAccess, rescan, setError });

  // Another virtual, never-persisted PlaylistRecord (same shape as
  // handleShowUnplaylisted below) - mirrors whatever's actually playing
  // right now (see playingContext's own doc), in file order, or the live
  // shuffled order when shuffle is on (getShuffleOrder() - null when
  // shuffle is off, since sequential order needs no separate tracking
  // there). No directory walk needed - everything here is already in
  // memory. Reads playlistPlayer.getShuffleOrder() directly rather than
  // gating on playerState.shuffleEnabled - the latter is only current as of
  // the last render, which matters for handleToggleShuffle below (called
  // synchronously right after toggling shuffle, before React re-renders).
  // Defined up here (not alongside handleShowUnplaylisted, its closer
  // sibling) specifically so handleToggleShuffle can reference it - this
  // needs to exist before usePlaylistTransport's own toggleShuffle output
  // does, since that's what gets wrapped below.
  const persistOpenedPlaylist = (playlist: PlaylistRecord, rootId: string) =>
    persistPlaybackPatch({ openedPlaylistId: playlist.id, openedRootId: rootId });
  const handleShowNowPlaying = () => showNowPlaying({ onOpened: persistOpenedPlaylist });

  const {
    playFromTrack,
    togglePause,
    seekTo,
    goNext,
    goPrevious,
    handleNextPress,
    handlePreviousPress,
    cycleLoopMode,
    toggleShuffle: toggleShuffleRaw,
  } = usePlaylistTransport({
    playlistPlayer,
    playerState,
    persistPlaybackPatch,
    transportActionAllowed,
    setPlayerState,
    setError,
    isTrackMissing: (fileId) => playingContext?.tracksById.get(fileId)?.missing === true || missingFileIds.has(fileId),
  });

  // Turning shuffle on makes the actually-playing playlist's real track
  // order stop matching what will actually play next - if the screen
  // currently open is that exact playlist, its display is now stale, so
  // this switches straight to the Now Playing automatic view (which always
  // reflects the live shuffle order) the moment shuffle turns on. A no-op
  // when turning shuffle off, or when looking at anything else (a
  // different playlist, Library, Unplaylisted) - only the specific "the
  // thing on screen just got reordered out from under you" case.
  const handleToggleShuffle = () => {
    const wasEnabled = playerState.shuffleEnabled;
    toggleShuffleRaw();
    if (!wasEnabled && playingContext && screen.kind === 'playlist' && screen.playlist.id === playingContext.playlist.id) {
      handleShowNowPlaying();
    }
  };

  // Stable across renders where the open playlist itself hasn't changed
  // (not recreated on every ~200ms playback poll tick, unlike an inline
  // arrow function here would be) - feeds into TrackList's own memoized
  // renderItem, which in turn is what lets TrackRow's memo() actually skip
  // re-rendering unchanged rows. Reads screen.kind at call time rather than
  // being defined only inside the screen.kind === 'playlist' branch below -
  // hooks can't be called conditionally, so this closes over `screen`
  // itself and no-ops if it's since navigated away from a playlist.
  const handlePressTrack = useCallback(
    (t: TrackRecord) => {
      if (screen.kind !== 'playlist') return;
      if (t.missing) missingTrackRelocation.explainMissingTrack(t, screen.playlist.rootId);
      else if (missingFileIds.has(t.fileId)) {
        // Already failed to open once this session (see usePlaylistTransport's
        // isTrackMissing doc) - not the scan-confirmed "unresolved playlist
        // entry" explainMissingTrack's relocation flow is for, just a file
        // that failed live, possibly transiently (e.g. still syncing).
        // Retrying would repeat the exact same doomed decode attempt, so
        // this reports the same error again immediately instead of trying.
        notificationCenter.addError(`Couldn't play "${trackDisplayName(t)}"`, 'This file failed to open earlier this session - it may still be syncing.');
      } else {
        markOpenPlaylistPlaying();
        void playFromTrack(screen.playlist, t);
      }
    },
    // notificationCenter.addError specifically - see refresh()'s identical
    // note on why the whole notificationCenter object isn't a safe dep here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screen, missingTrackRelocation, playFromTrack, missingFileIds, markOpenPlaylistPlaying, notificationCenter.addError],
  );

  const { volume, handleVolumeChange } = useVolumeControl({ playlistPlayer, persistPlaybackPatch, isRestoring });

  const {
    outgoingTrack,
    incomingTrack,
    outgoingCoverArt,
    incomingCoverArt,
    outgoingGain,
    incomingGain,
    outgoingProgress,
    displayPositionSeconds,
    displayDurationSeconds,
    currentTurnsPerSecond,
    settledCurrentMetadata,
    settledNextTrack,
    settledNextMetadata,
    currentTitle,
    currentName,
    currentArtist,
  } = useCrossfadePlaybackDisplay({
    playlistPlayer,
    playerState,
    activeTracksById: playingContext?.tracksById ?? NO_TRACKS,
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

  const lastFm = useLastFmConnection(settings, updateSettings);
  useLastFmScrobbling(
    libraryStore,
    settings,
    playerState.currentFileId && hasStartedPlayback
      ? {
          fileId: playerState.currentFileId,
          title: currentName,
          artist: currentArtist ?? 'Unknown artist',
          album: settledCurrentMetadata?.album ?? null,
          durationSeconds: displayDurationSeconds,
        }
      : null,
    playerState.track.status === 'playing',
    displayPositionSeconds,
  );

  // Rendered even with nothing loaded (currentFileId null) - see
  // MiniPlayerBar's own doc for why: volume needs to stay reachable, and
  // this is also the only way to reach NowPlayingScreen (where loop/shuffle
  // live) before anything's ever played. disabled dims/no-ops the transport
  // buttons, which are meaningless (and already no-ops at the player level)
  // with no track loaded.
  const miniPlayerBar = (
    <MiniPlayerBar
      colors={colors}
      title={currentName || 'Nothing playing'}
      artist={currentArtist}
      artUri={outgoingCoverArt}
      isPlaying={playerState.track.status === 'playing'}
      positionSeconds={displayPositionSeconds}
      durationSeconds={displayDurationSeconds}
      volume={volume}
      onChangeVolume={handleVolumeChange}
      onPress={() => {
        setNowPlayingOpen(true);
        persistPlaybackPatch({ nowPlayingOpen: true });
      }}
      onPlayPause={togglePause}
      onNext={handleNextPress}
      onPrevious={handlePreviousPress}
      disabled={!playerState.currentFileId}
    />
  );

  // See apps/mobile/App.tsx's identical currentTrackHasLyrics for why.
  const currentTrackHasLyrics = useHasLyrics(libraryStore, playerState.currentFileId ?? '');

  // See apps/mobile/App.tsx's identical lyricsMenu for why both actions
  // also force-open Now Playing.
  const lyricsMenu =
    playerState.currentFileId && currentTrackHasLyrics
      ? {
          onOpenEditor: () => {
            openLyricsEditorFromMenu();
            persistPlaybackPatch({ nowPlayingOpen: true });
          },
          onChangeFile: () => {
            openLyricsPickerFromMenu();
            persistPlaybackPatch({ nowPlayingOpen: true });
          },
        }
      : undefined;

  // Identical at every call site (Now Playing's headerRight, the
  // playlist screen's HeaderRow right slot, and the library screen's
  // headerRight) - hoisted once rather than reconstructed per site.
  const headerActionsEl = <HeaderActions colors={colors} center={notificationCenter} onOpenSettings={openSettings} lyricsMenu={lyricsMenu} />;
  // Side-by-side tiers show several panes at once, each with its own header
  // - only the docked Now Playing pane (rightmost, so the window's top-right
  // corner) carries the settings/notification buttons there, instead of one
  // copy per pane. The narrow tier shows one screen at a time, so each keeps
  // its own.
  const paneHeaderActionsEl = tier === 'narrow' ? headerActionsEl : undefined;

  // Bare content, reused two ways below: wrapped in a ScreenLayer overlay
  // (narrow tier, opened/closed via MiniPlayerBar/onClose) or placed
  // directly as MultiPaneLayout's docked pane (medium/wide tier, always
  // visible - see NowPlayingScreen's onClose doc for why it's omitted, not
  // just a no-op, in that case). Rendered even with nothing loaded, same
  // reasoning as miniPlayerBar above - CrossfadeArt/SeekBar/LyricsSection
  // all already tolerate null art/zero duration/null trackFileId
  // gracefully, so this just needs a friendly title and disabled transport
  // buttons rather than any real restructuring.
  const nowPlayingContent = (
    <NowPlayingScreen
        colors={colors}
        onClose={
          tier === 'narrow'
            ? () => {
                setNowPlayingOpen(false);
                persistPlaybackPatch({ nowPlayingOpen: false });
              }
            : undefined
        }
        title={currentTitle ?? 'Nothing playing'}
        upNextTitle={settledNextTrack ? formatTrackTitle(settledNextMetadata, settledNextTrack) : null}
        lyricsTrackKey={(pendingIncoming ? incomingTrack?.fileId : outgoingTrack?.fileId) ?? null}
        lyricsEnabled={settings.lyricsEnabled}
        currentArtUri={outgoingCoverArt}
        currentGain={outgoingGain}
        currentProgress={outgoingProgress}
        currentTurnsPerSecond={currentTurnsPerSecond}
        nextArtUri={incomingCoverArt}
        nextGain={incomingGain}
        isLoading={playerState.isLoadingForPlayback}
        positionSeconds={displayPositionSeconds}
        durationSeconds={displayDurationSeconds}
        // Disabled mid-crossfade: seekTo() still only affects the actual
        // (outgoing) source, which no longer matches what the screen is
        // showing (the incoming track's position/duration) - a tap here
        // would compute a fraction against the wrong track's duration.
        onSeekTo={pendingIncoming ? () => {} : seekTo}
        fileAccess={fileAccess}
        libraryStore={libraryStore}
        lyricsScopes={lyricsScopes}
        headerRight={headerActionsEl}
        lyricsEditorOpen={lyricsEditorOpen}
        onLyricsEditorOpenChange={setLyricsEditorOpen}
        lyricsPickerOpen={lyricsPickerOpen}
        onLyricsPickerOpenChange={setLyricsPickerOpen}
        controls={
          <PlayerControlsRow
            colors={colors}
            loopMode={playerState.loopMode}
            onCycleLoop={cycleLoopMode}
            shuffleEnabled={playerState.shuffleEnabled}
            onToggleShuffle={handleToggleShuffle}
            volume={volume}
            onChangeVolume={handleVolumeChange}
            showVolumeButton={settings.showVolumeButtonOnNowPlaying}
            isPlaying={playerState.track.status === 'playing'}
            onTogglePlayPause={togglePause}
            onPrevious={handlePreviousPress}
            onNext={handleNextPress}
            disabled={!playerState.currentFileId}
          />
        }
      />
  );

  // zIndex + backgroundColor here must beat/cover HeaderRow's own zIndex
  // (1, see its doc) - without an explicit, higher zIndex, the playlist/
  // library screen underneath's own HeaderRow (its back-row title +
  // NotificationBell) painted ABOVE this whole overlay despite being
  // mounted earlier: a nested descendant's zIndex doesn't just win among
  // its own siblings, it also outranks an ancestor-level sibling with no
  // zIndex of its own - confirmed on the mobile app as two overlapping
  // header rows/bells ("Playlist: In Order" bleeding through "Now
  // Playing"'s own header). Also needed an explicit background (which
  // ScreenLayer always sets) since NowPlayingScreen's own container has
  // none either - without one this overlay was fully transparent on web,
  // which would show the exact same bleed-through for the WHOLE screen,
  // not just the header band. Only rendered on the narrow tier - medium/
  // wide instead place nowPlayingContent directly as MultiPaneLayout's
  // docked pane, unwrapped, always visible rather than opened/closed.
  const nowPlayingScreen = tier === 'narrow' && nowPlayingScreenOpen && nowPlayingContent && (
    <ScreenLayer zIndex={10} colors={colors}>
      {nowPlayingContent}
    </ScreenLayer>
  );

  // Higher zIndex than nowPlayingScreen's (10, above) - opened from a header
  // button reachable on every screen INCLUDING Now Playing, so it has to be
  // able to sit on top of that overlay too, not just the library/playlist
  // screen underneath both.
  const settingsScreen = settingsOpen && (
    <ScreenLayer zIndex={20} colors={colors}>
      <SettingsScreen
        colors={colors}
        settings={settings}
        onUpdateSettings={updateSettings}
        onResetSettings={resetSettings}
        onClose={() => closeSettings()}
        volume={volume}
        onChangeVolume={handleVolumeChange}
        lastFm={lastFm}
        onOpenExternalConnections={() => openExternalConnections()}
      />
    </ScreenLayer>
  );

  // Higher zIndex than settingsScreen's (20, above) - a sub-screen reached
  // from within Settings (see ExternalConnectionsScreen's own doc), so it
  // has to sit on top of it, not beside it.
  const externalConnectionsScreen = externalConnectionsOpen && (
    <ScreenLayer zIndex={21} colors={colors}>
      <ExternalConnectionsScreen colors={colors} settings={settings} onUpdateSettings={updateSettings} lastFm={lastFm} onClose={() => closeExternalConnections()} />
    </ScreenLayer>
  );

  // Opened from TrackList's "Edit raw" button (a real playlist only - see
  // isRealPlaylistScreen) - zIndex 15, above the docked/overlaid Now
  // Playing screen (10) since it's reachable from the playlist screen
  // underneath that, below Settings (20) since it's not reachable from there.
  const editPlaylistFileScreen = editingPlaylistFile && (
    <ScreenLayer zIndex={15} colors={colors}>
      <EditPlaylistFileScreen
        colors={colors}
        fileAccess={fileAccess}
        rootId={editingPlaylistFile.root.id}
        playlist={editingPlaylistFile.playlist}
        onCancel={() => setEditingPlaylistFile(null)}
        onSaved={() => {
          void rescan(editingPlaylistFile.root.id);
          setEditingPlaylistFile(null);
        }}
      />
    </ScreenLayer>
  );

  // Covers the library scan + playback-state restore's own async window -
  // without this, the library screen would render first (empty, then
  // populated) and only jump to a restored playlist screen a beat later,
  // which reads as a flash/flicker rather than landing directly on the
  // right screen.
  if (isRestoring) {
    return (
      <RestoringScreen colors={colors} completedSteps={completedSteps} currentStep={currentStep} hasLyricsScopes={hasLyricsScopes} />
    );
  }

  if (createPlaylistRootId) {
    const root = grantedRoots.find((r) => r.id === createPlaylistRootId);
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <FolderBrowser
          colors={colors}
          fileAccess={fileAccess}
          rootId={createPlaylistRootId}
          rootDisplayName={root?.displayName ?? createPlaylistRootId}
          onSelect={(relativePath) => {
            chooseCreatePlaylistFolder({
              rootId: createPlaylistRootId,
              folderRelativePath: relativePath,
              folderDisplayName: relativePath ? `${root?.displayName ?? ''}/${relativePath}` : (root?.displayName ?? ''),
            });
          }}
          onCancel={() => endCreatePlaylist()}
        />
      </View>
    );
  }

  if (missingTrackRelocation.locateTarget) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <LocateMissingFileScreen
          colors={colors}
          missingTrackName={trackDisplayName(missingTrackRelocation.locateTarget.track)}
          candidates={missingTrackRelocation.candidates}
          relocating={missingTrackRelocation.relocating}
          onSelect={(file) => void missingTrackRelocation.selectCandidate(file)}
          onCancel={missingTrackRelocation.cancelLocate}
        />
      </View>
    );
  }

  if (createPlaylistTarget) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <CreatePlaylistScreen
          colors={colors}
          fileAccess={fileAccess}
          rootId={createPlaylistTarget.rootId}
          folderRelativePath={createPlaylistTarget.folderRelativePath}
          folderDisplayName={createPlaylistTarget.folderDisplayName}
          onCancel={() => endCreatePlaylist()}
          onCreated={() => {
            endCreatePlaylist();
            void rescan(createPlaylistTarget.rootId);
          }}
        />
      </View>
    );
  }

  // closePlaylistScreen is shared between this back button and
  // useBackNavigation's closePlaylist action above, both of which have to
  // agree on clearing the persisted "opened" playlist the same way.
  const closePlaylistScreen = () => {
    openLibrary();
    persistPlaybackPatch({ openedPlaylistId: null, openedRootId: null });
  };

  // Builds a virtual, never-persisted PlaylistRecord (a synthetic id -
  // see findUnplaylistedTracks' own doc - never written via
  // libraryStore.upsertPlaylist) and opens it through the exact same
  // screen/persistence path as a real playlist. The individual tracks
  // themselves DO get persisted (findUnplaylistedTracks upserts any
  // newly-discovered one into the store), so metadata/art scanning and
  // playback all work on them normally - only the *playlist itself* is
  // recomputed fresh every time rather than stored, since membership can
  // change the moment any other playlist is edited.
  const handleShowUnplaylisted = (rootId: string) => showUnplaylisted(rootId, { onOpened: persistOpenedPlaylist });

  // Only the Unplaylisted virtual playlist offers "add to playlist" per
  // row (see TrackRow.onAddToPlaylist's doc) - Now Playing's virtual
  // playlist has no such use case, and every real playlist's tracks are
  // by definition already in a playlist.
  const isUnplaylistedScreen = screen.kind === 'playlist' && screen.playlist.id === `virtual:${screen.root.id}:unplaylisted`;
  // Gates TrackList's reorder mode and "Edit raw" button - both write to a
  // real .m3u8, which neither virtual playlist (Unplaylisted, Now Playing)
  // has one of. See apps/mobile/App.tsx's identical block.
  const isRealPlaylistScreen = screen.kind === 'playlist' && !screen.playlist.id.startsWith('virtual:');

  const addToPlaylistDialog =
    addToPlaylistTrack && screen.kind === 'playlist' ? (
      <AddToPlaylistDialog
        colors={colors}
        playlists={rootsWithLibrary.find((r) => r.root.id === screen.root.id)?.playlists ?? []}
        trackLabel={trackDisplayName(addToPlaylistTrack)}
        onCancel={() => setAddToPlaylistTrack(null)}
        onSelect={(playlist, position) => addPendingTrackToPlaylist(playlist, position, rescan)}
      />
    ) : null;

  // Split into two independent elements (rather than one screenContent
  // picked by screen.kind, as before) - the narrow tier still shows only
  // one of them at a time (see screenContent below), but medium/wide need
  // library and playlist as separate simultaneous panes (see
  // MultiPaneLayout).
  const playlistPaneContent =
    screen.kind === 'playlist' ? (
      <>
        <HeaderRow style={styles.backRow} left={<BackButton text={`Playlist: ${screen.playlist.name}`} color={colors.text} onPress={closePlaylistScreen} />} right={paneHeaderActionsEl} />
        {error && <Text style={styles.error}>{error}</Text>}
        {isUnplaylistedScreen && isFindingUnplaylisted && <Text style={[styles.notice, { color: colors.subtleText }]}>Finding songs not in a playlist…</Text>}
        <TrackList
          trackFileIds={screen.playlist.trackFileIds}
          tracksById={screen.tracksById}
          currentFileId={playerState.currentFileId}
          isPlaying={playerState.track.status === 'playing'}
          isLoading={playerState.isLoadingForPlayback}
          textColor={colors.text}
          colors={colors}
          onPressTrack={handlePressTrack}
          libraryStore={libraryStore}
          initialNumToRender={30}
          missingFileIds={missingFileIds}
          onAddToPlaylist={isUnplaylistedScreen ? setAddToPlaylistTrack : undefined}
          onMoveTracks={
            isRealPlaylistScreen
              ? (movingFileIds, anchorFileId, position) => moveTracks(movingFileIds, anchorFileId, position, rescan)
              : undefined
          }
          onRemoveTracks={
            isRealPlaylistScreen
              ? (fileIds) => removeTracks(fileIds, rescan)
              : undefined
          }
          onEditRaw={isRealPlaylistScreen ? () => setEditingPlaylistFile({ root: screen.root, playlist: screen.playlist }) : undefined}
        />
      </>
    ) : null;

  const libraryPaneContent = (
      <LibraryScreen
        colors={colors}
        rootsWithLibrary={rootsWithLibrary}
        isLoadingRoots={isLoadingRoots}
        isAddingFolder={busyRootId !== null && !rootsWithLibrary.some(({ root }) => root.id === busyRootId)}
        isRootScanning={isRootScanning}
        onAddFolder={addFolder}
        onRescan={rescan}
        onRemoveRoot={(rootId) => void removeRoot(rootId)}
        onCreatePlaylist={(rootId) => startCreatePlaylist(rootId)}
        onShowUnplaylisted={handleShowUnplaylisted}
        nowPlayingRootId={playingContext?.root.id ?? null}
        onShowNowPlaying={playingContext ? handleShowNowPlaying : undefined}
        nowPlayingPlaylistId={playingContext?.playlist.id ?? null}
        nowPlayingIsShuffled={playerState.shuffleEnabled}
        onSelectPlaylist={(root, playlist, tracksById) => openPlaylist({ root, playlist, tracksById }, { onOpened: persistOpenedPlaylist })}
        error={error}
        listStyle={styles.list}
        headerRight={paneHeaderActionsEl}
        secondaryAddButton={
          <FolderPickerButton colors={colors} icon={mdiSubtitles} text="Add Lyrics Folder" onPress={addLyricsFolder} />
        }
        bannerContent={
          <>
            {!SUPPORTS_DIRECTORY_PICKER && !serverBackendAvailable && (
              <Text style={styles.warning}>
                This browser can’t pick local folders. Use the self-hosted Docker server instead to browse a mounted music
                library -{' '}
                <a href={SELF_HOSTING_DOCS_URL} target="_blank" rel="noopener noreferrer" style={webLinkStyle}>
                  see the setup guide
                </a>
                .
              </Text>
            )}
            {!SUPPORTS_DIRECTORY_PICKER && serverBackendAvailable && (
              <Text style={[styles.hint, { color: colors.text }]}>
                To add a new folder here, bind-mount it into the Docker server instead of picking it from the browser -{' '}
                <a href={SELF_HOSTING_DOCS_URL} target="_blank" rel="noopener noreferrer" style={webLinkStyle}>
                  see the setup guide
                </a>
                .
              </Text>
            )}
            {showInstallOnboarding && (
              <View style={[styles.installOnboarding, { borderColor: colors.accent }]}>
                <Text style={[styles.installOnboardingText, { color: colors.text }]}>
                  Install BPMix as an app to keep folder access working across reloads - a browser tab has to ask again every
                  so often, but an installed app doesn’t.
                </Text>
                <View style={styles.installOnboardingActions}>
                  <Pressable
                    onPress={() => {
                      void promptInstall();
                      dismissInstallOnboarding();
                    }}
                  >
                    <Text style={[styles.installOnboardingAction, { color: colors.accent }]}>Install</Text>
                  </Pressable>
                  <Pressable onPress={dismissInstallOnboarding}>
                    <Text style={[styles.installOnboardingAction, { color: colors.subtleText }]}>Not now</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </>
        }
        lyricsSection={
          <LyricsFolderSection
            colors={colors}
            scopes={lyricsScopes}
            rootDisplayName={(rootId) => grantedRoots.find((r) => r.id === rootId)?.displayName ?? rootId}
            scopeRemovable={(rootId) => grantedRoots.find((r) => r.id === rootId)?.removable !== false}
            matchedTrackCount={matchedLyricsCount}
            totalTrackCount={rootsWithLibrary.reduce((sum, { tracksById }) => sum + tracksById.size, 0)}
            busyScopeKey={busyLyricsScopeKey}
            onRemoveScope={(rootId, relativePath) => void removeLyricsScope(rootId, relativePath)}
            onRescan={(rootId, relativePath) => void rescanLyricsScope(rootId, relativePath)}
          />
        }
      />
  );

  const missingFileDialog = missingTrackRelocation.explainTarget && (
    <ConfirmDialog
      colors={colors}
      title="Missing File"
      message={`BPMix couldn't find "${trackDisplayName(missingTrackRelocation.explainTarget.track)}" at its expected location (${missingTrackRelocation.explainTarget.track.relativePath}). It may have been moved, renamed, or deleted.`}
      confirmLabel="Locate File…"
      onCancel={missingTrackRelocation.cancelExplain}
      onConfirm={missingTrackRelocation.beginLocate}
    />
  );


  if (tier === 'narrow') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.screenArea}>{playlistPaneContent ?? libraryPaneContent}</View>
        {miniPlayerBar}
        {nowPlayingScreen}
        {settingsScreen}
        {externalConnectionsScreen}
        {editPlaylistFileScreen}
        {missingFileDialog}
        {addToPlaylistDialog}
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.screenArea}>
        <MultiPaneLayout tier={tier} colors={colors} libraryPane={libraryPaneContent} playlistPane={playlistPaneContent} nowPlayingPane={nowPlayingContent} />
      </View>
      {miniPlayerBar}
      {settingsScreen}
      {externalConnectionsScreen}
      {editPlaylistFileScreen}
      {missingFileDialog}
      {addToPlaylistDialog}
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
    // This is meant to be a fixed, non-scrolling app shell - every genuinely
    // scrollable region (TrackList, the library roots list, ...) already
    // manages its own bounded-height scroll area. Without this, a
    // decorative absolutely-positioned element that overflows its own
    // container - confirmed as CrossfadeArt's Tonearm, whose rotor box is
    // deliberately oversized (see its own doc) and legitimately extends
    // past the disc's own square in its resting position - leaks all the
    // way up to inflate the real page's scrollWidth/scrollHeight, showing
    // up as actual browser scrollbars around the whole app. Clipping here,
    // at the one true outer boundary, contains that without having to hunt
    // down (and risk breaking) every individual component that might
    // someday overflow its own nominal box the same way.
    overflow: 'hidden',
  },
  // Wraps the library/playlist content so it can flex to fill the space
  // above MiniPlayerBar/NowPlayingScreen instead of the two overlapping -
  // container itself can't grow the content because it also hosts those
  // siblings. flex:1 here (not just on list) keeps FlatList's bounded-height
  // ancestor chain intact - see list's own comment.
  screenArea: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
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
  notice: {
    marginTop: 12,
    marginHorizontal: 16,
    fontSize: 13,
  },
  hint: {
    opacity: 0.6,
    marginTop: 12,
    maxWidth: 480,
    textAlign: 'center',
  },
  installOnboarding: {
    marginTop: 12,
    maxWidth: 480,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  installOnboardingText: {
    textAlign: 'center',
  },
  installOnboardingActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
  },
  installOnboardingAction: {
    fontWeight: '600',
  },
  backRow: {
    width: '100%',
    maxWidth: 480,
  },
  // Merged onto LibraryScreen's own base list style - see its listStyle prop's doc.
  list: {
    flex: 1,
  },
});

export default App;

/**
 * BPMix - Stage 3: playlist queue playback with loop modes and shuffle,
 * on top of Stage 2's single-track playback.
 * @format
 */

import type { FileRef, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import {
  BUILD_VERSION,
  DEFAULT_DISCORD_APPLICATION_ID,
  addError,
  createStore,
  playerAdvanced,
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
  getAccentColorHex,
  HeaderActions,
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
  useAppSettings,
  useAppUpdateCheck,
  useCrossfadePlaybackDisplay,
  ExternalConnectionsScreen,
  useDiscordPresence,
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
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { createAppUpdateBridge } from './src/adapters/appUpdate';
import { createAudioEngine } from './src/adapters/audioEngine';
import { createDiscordPresenceBridge } from './src/adapters/discordRpc';
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

const fileAccess = createFileAccess();
const libraryStore = createLibraryStore();
// Kicked off immediately at module load - the earliest this can possibly
// start, well before any component mounts - and shared by both
// playlistPlayer.awaitInitialVolume() below and usePlaybackPersistence's
// own restore effect (see that hook's initialPlaybackStatePromise doc) so
// there's only ever one fetch of the persisted state, not two
// independently-timed ones racing each other.
const initialPlaybackStatePromise = libraryStore.getPlaybackState();
const audioEngine = createAudioEngine(fileAccess);
const coverArtResizer = createCoverArtResizer();
// Never offers an update in a debug build (__DEV__) - checkForUpdate
// already treats a dev build's non-clean-semver git-describe version
// ("v1.2.3-N-gHASH") as unparseable and never reports an update for it
// (see its own doc), but that only holds as long as the build wasn't made
// exactly at a tagged commit - git describe then reports a perfectly
// clean "vX.Y.Z", indistinguishable from a real release build at that
// same commit, so a debug build checked out right at a release tag could
// still be offered (and could download/install) that real release APK.
// Disabling the whole bridge here is a stronger guarantee than relying on
// that version string alone, and reuses the same "no bridge -> Settings
// omits the whole row" escape hatch appUpdate.windows.ts already uses for
// platforms with no install flow at all.
const appUpdateBridge = __DEV__ ? null : createAppUpdateBridge();
const discordPresenceBridge = createDiscordPresenceBridge();

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
    // Pushes an immediate re-render and persists where it landed when position changes
    // outside a manual UI action (a crossfade completing, a natural end auto-advancing).
    onAdvance: () => store.dispatch(playerAdvanced()),
    crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
    // Just-in-time analysis (Stage 4): a track already needed a decode for
    // playback/preload, so analyzing it here is free - no separate eager
    // batch pass over the whole library.
    onDecoded: (ref, decoded) => {
      void ensureTrackAnalyzed(libraryStore, ref, decoded, audioEngine);
      store.dispatch(fileFoundReported(ref.id));
    },
  },
);
// See PlaylistPlayer.awaitInitialVolume's own doc - guarantees the real
// persisted volume is applied before the first playAt() of this session
// ever becomes audible, for every possible trigger (UI, media-session/
// lock-screen controls), not just whichever one happens to run after
// usePlaybackPersistence's own React effect gets around to it. 0.25
// matches both TrackPlayer's own masterVolume field default and
// usePlaybackPersistence's playbackStateRef default - "nothing was ever
// persisted" should produce the same volume either way.
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
  initialPlaybackState: initialPlaybackStatePromise,
  coverArtResizer,
  appUpdateBridge,
  discordPresenceBridge,
  // No always-rescanned (self-hosted server) roots on mobile, and no browser-style
  // gesture-gated permission model, so background work uses the plain adapter.
  backgroundFileAccess: fileAccess,
  alwaysRescanRoot: () => false,
  now: Date.now,
});

/** fileId is the track a decode/playback error actually happened for, when known - see PlaylistPlayer's onError doc. Routed to the notification bell, not the error banner - see NotificationBell's doc for why. */
function reportPlaybackError(error: unknown, fileId?: string): void {
  store.dispatch(addError(fileId ? `Couldn't play "${fileId.split('/').pop()}"` : 'Playback error', errorMessage(error)));
  if (fileId) store.dispatch(fileMissingReported(fileId));
}

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

function App() {
  return (
    <StoreProvider store={store}>
      <SafeAreaProvider>
        <AppContent />
      </SafeAreaProvider>
    </StoreProvider>
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
  const { settings, updateSettings, resetSettings } = useAppSettings();
  const colors = useThemeColors(settings.themeMode, getAccentColorHex(settings.accentColor));
  // See useViewportTier's doc - 'narrow' keeps today's single-screen-plus-
  // overlay behavior below; 'medium'/'wide' switch to MultiPaneLayout.
  const tier = useViewportTier();
  // StatusBar text needs to track the resolved theme, not the raw system
  // scheme - a user who explicitly picks Dark/AMOLED against a light-mode
  // system would otherwise get dark-on-dark, unreadable status bar text.
  const statusBarStyle = settings.themeMode === 'dark' || settings.themeMode === 'amoled' ? 'light-content' : 'dark-content';
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
  } = useLibrary();
  const dispatch = useAppDispatch();
  // Android only - true after requestRoot() throws AllFilesAccessRequiredError, so the error banner can offer a direct "Open Settings" retry instead of just describing the problem.
  const [needsAllFilesAccess, setNeedsAllFilesAccess] = useState(false);
  // Set while FolderBrowser is open picking a brand-new root (Android's
  // MANAGE_EXTERNAL_STORAGE flow only - see registerRootBrowser's doc in
  // fileAccess.android.ts; a no-op registration on Windows means this never
  // gets set there, since requestRoot() uses its own native FolderPicker).
  const [rootBrowserRequest, setRootBrowserRequest] = useState<{
    storageRootPath: string;
    storageRootDisplayName: string;
    resolve: (relativePath: string | null) => void;
  } | null>(null);
  // Everything that used to be a one-shot setError(errorMessage(err)) string
  // (playback/decode failures specifically) now goes here instead - see
  // NotificationBell's doc for why a raw error string as the *entire*
  // message wasn't good enough on its own. `error`/setError (from useLibrary) is left
  // alone for the handful of direct-action error paths (addFolder, rescan,
  // etc.) that still want an immediate, action-adjacent inline message.
  const notificationCenter = useNotificationCenter();
  // fileIds whose most recent decode attempt failed - TrackRow reads this to
  // show a missing-file indicator instead of pretending everything's fine
  // until the user taps play and it silently does nothing.
  // Drives RestoringScreen's checklist - see refresh()'s and
  // usePlaybackPersistence's onStepChange updates below.
  const { completedSteps, currentStep, hasLyricsScopes } = useRestoringProgress();
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
    setEditingPlaylistFile,
    setAddToPlaylistTrack,
    showNowPlaying,
    showUnplaylisted,
    moveTracks,
    removeTracks,
    addPendingTrackToPlaylist,
  } = usePlaylistScreen();
  const playerState = useLivePlayerState(livePlayback);
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
  const hasStartedPlayback = useAppSelector((state) => state.playback.hasStartedPlayback);

  useMemoryUsageLogging(playerState.track.status !== 'idle');

  // Same close-priority order as the web app (see useBackNavigation's doc) -
  // Settings, then Now Playing, then Playlist back to Library, then (nothing
  // left of ours to close) the default hardware-back behavior of exiting.
  // extraHandler runs first: it closes BPMix's Android-only folder-picker
  // overlays, which the web app has no equivalent of at all.
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
    registerRootBrowser(
      (storageRootPath, storageRootDisplayName) =>
        new Promise((resolve) => {
          setRootBrowserRequest({ storageRootPath, storageRootDisplayName, resolve });
        }),
    );
    return () => registerRootBrowser(null);
  }, []);

  // Loading lives in the refreshLibrary thunk (see @bpmix/core's store/library).
  const refresh = useCallback(() => dispatch(refreshLibrary()), [dispatch]);

  const { isRestoring, persistPlaybackPatch, persistPositionIfDue, notifyUserTookOver } = usePlaybackPersistence();

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
      openLibrary();
      setNowPlayingOpen(false);
      closeSettings();
    } else if (path === 'now-playing') {
      setNowPlayingOpen(true);
      closeSettings();
    }
  }, [setNowPlayingOpen, closeSettings, openLibrary]);

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

  // Stage 6 lookahead (checkPreload) reuses this tick instead of a second timer.
  useEffect(
    () => startPlaybackTicker({ livePlayback, playlistPlayer, onTick: persistPositionIfDue }),
    [persistPositionIfDue],
  );

  // Double-click/double-tap invocation guarding (e.g. against opening two
  // concurrent native folder-picker prompts, observed on Windows to leave
  // the WinRT broker in a bad state and surface later as an
  // unrelated-looking "The file is in use" error during a scan) lives in
  // FolderPickerButton (packages/ui) now, not here - this is just the plain
  // pick-and-handle operation it wraps.
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
  //
  // Rescan is the one place a user explicitly asks to re-check a folder,
  // but deliberately does NOT force past the cheap sizeBytes/lastModifiedMs
  // freshness gate - see apps/web/src/App.tsx's identical verifyRootMetadata
  // for the full reasoning (an earlier always-forced version re-hashed
  // every track on every Rescan and contended with the folder walk over
  // the same I/O). Runs as its own idle-chunked pass with its own
  // notification row, scoped to the rescanned root.
  const verifyRootMetadata = useCallback(
    async (rootId: string) => {
      // Most-recently-modified first - see apps/web/src/App.tsx's identical
      // verifyRootMetadata for why.
      const tracks = (await libraryStore.listTracks(rootId)).filter((t) => !t.missing).sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
      await scanLibraryMetadataQueued({ id: `metadata-verify-${rootId}`, label: 'Verifying track metadata' }, fileAccess, libraryStore, tracks, {
        resizer: coverArtResizer,
      });
      await refresh();
    },
    [refresh],
  );

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
      onAddFolderStart: () => setNeedsAllFilesAccess(false),
      onAddFolderError: (err) => {
        if (err instanceof AllFilesAccessRequiredError) {
          setNeedsAllFilesAccess(true);
        }
      },
      onUnresolvedEntries: (title, detail) => notificationCenter.addError(title, detail),
      onRescanned: (rootId) => void verifyRootMetadata(rootId),
      browseDeviceStorage,
    });

  useTaskNotifications();

  useOpenPlaylistMetadataScan({ fileAccess, libraryStore, resizer: coverArtResizer, screen });

  const missingTrackRelocation = useMissingTrackRelocation({ fileAccess, rescan, setError });

  // See apps/web/src/App.tsx's identical block for why this is defined up
  // here (ahead of usePlaylistTransport's own toggleShuffle output, which
  // handleToggleShuffle below wraps) rather than alongside its closer
  // sibling handleShowUnplaylisted. Mirrors whatever's actually playing, or
  // the live shuffle order instead if shuffle is on - reads
  // playlistPlayer.getShuffleOrder() directly rather than gating on
  // playerState.shuffleEnabled, which would still read stale (pre-toggle)
  // when handleToggleShuffle calls this synchronously right after toggling.
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

  // See apps/web/src/App.tsx's identical handleToggleShuffle for why.
  const handleToggleShuffle = () => {
    const wasEnabled = playerState.shuffleEnabled;
    toggleShuffleRaw();
    if (!wasEnabled && playingContext && screen.kind === 'playlist' && screen.playlist.id === playingContext.playlist.id) {
      handleShowNowPlaying();
    }
  };

  // See apps/web/src/App.tsx's identical handlePressTrack for why this is
  // memoized - stabilizes TrackList's renderItem, which is what lets
  // TrackRow's memo() actually skip re-rendering unchanged rows.
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
    // notificationCenter.addError specifically - see the reportError effect's
    // identical note on why the whole notificationCenter object isn't a safe dep here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screen, missingTrackRelocation, playFromTrack, missingFileIds, markOpenPlaylistPlaying, notificationCenter.addError],
  );

  const { volume, handleVolumeChange } = useVolumeControl({ playlistPlayer, persistPlaybackPatch, isRestoring });
  const appUpdate = useAppUpdateCheck({ currentVersion: BUILD_VERSION, bridge: appUpdateBridge });

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

  useDiscordPresence(
    discordPresenceBridge,
    DEFAULT_DISCORD_APPLICATION_ID,
    settings.discordRichPresenceEnabled,
    playerState.currentFileId && hasStartedPlayback && playerState.track.status === 'playing'
      ? { fileId: playerState.currentFileId, title: currentName, artist: currentArtist ?? 'Unknown artist', albumArtUrl: outgoingCoverArt }
      : null,
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

  // Drives the lyrics icon's presence in headerActionsEl below - reused
  // across every screen's header (see that doc), so this has to tolerate
  // "" when nothing's currently loaded (useHasLyrics can't be called
  // conditionally - it just caches "" to false, harmlessly).
  const currentTrackHasLyrics = useHasLyrics(libraryStore, playerState.currentFileId ?? '');

  // Reachable from every screen's header (see headerActionsEl below), not
  // just Now Playing - selecting either action force-opens Now Playing
  // itself too (nowPlayingScreen's own `&&` requires nowPlayingScreenOpen
  // on the narrow tier; medium/wide's docked pane renders regardless), so
  // the editor/picker it opens inside LyricsSection is actually visible
  // rather than opening invisibly behind the screen the user happened to
  // be on.
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

  // Bare content, reused two ways below - see apps/web/src/App.tsx's
  // identical nowPlayingContent for why (wrapped in a ScreenLayer overlay
  // on the narrow tier, placed directly as MultiPaneLayout's docked pane
  // on medium/wide). Rendered even with nothing loaded, same reasoning as
  // miniPlayerBar above - CrossfadeArt/SeekBar/LyricsSection all already
  // tolerate null art/zero duration/null trackFileId gracefully, so this
  // just needs a friendly title and disabled transport buttons rather than
  // any real restructuring.
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
  // Only rendered on the narrow tier - medium/wide instead place
  // nowPlayingContent directly as MultiPaneLayout's docked pane.
  const nowPlayingScreen = tier === 'narrow' && nowPlayingScreenOpen && nowPlayingContent && (
    <ScreenLayer zIndex={10} colors={colors} paddingTop={insets.top} paddingBottom={insets.bottom} paddingLeft={insets.left} paddingRight={insets.right}>
      {nowPlayingContent}
    </ScreenLayer>
  );

  // Higher zIndex than nowPlayingScreen's (10, above) - opened from a header
  // button reachable on every screen INCLUDING Now Playing, so it has to be
  // able to sit on top of that overlay too, not just the library/playlist
  // screen underneath both.
  const settingsScreen = settingsOpen && (
    <ScreenLayer zIndex={20} colors={colors} paddingTop={insets.top} paddingBottom={insets.bottom} paddingLeft={insets.left} paddingRight={insets.right}>
      <SettingsScreen
        colors={colors}
        settings={settings}
        onUpdateSettings={updateSettings}
        onResetSettings={resetSettings}
        onClose={() => closeSettings()}
        volume={volume}
        onChangeVolume={handleVolumeChange}
        appUpdate={appUpdateBridge ? appUpdate : undefined}
        lastFm={lastFm}
        onOpenExternalConnections={() => openExternalConnections()}
      />
    </ScreenLayer>
  );

  // Higher zIndex than settingsScreen's (20, above) - a sub-screen reached
  // from within Settings (see ExternalConnectionsScreen's own doc), so it
  // has to sit on top of it, not beside it.
  const externalConnectionsScreen = externalConnectionsOpen && (
    <ScreenLayer zIndex={21} colors={colors} paddingTop={insets.top} paddingBottom={insets.bottom} paddingLeft={insets.left} paddingRight={insets.right}>
      <ExternalConnectionsScreen
        colors={colors}
        settings={settings}
        onUpdateSettings={updateSettings}
        lastFm={lastFm}
        onClose={() => closeExternalConnections()}
      />
    </ScreenLayer>
  );

  // Opened from TrackList's "Edit raw" button (a real playlist only - see
  // isRealPlaylistScreen) - zIndex 15, above the docked/overlaid Now
  // Playing screen (10) since it's reachable from the playlist screen
  // underneath that, below Settings (20) since it's not reachable from there.
  const editPlaylistFileScreen = editingPlaylistFile && (
    <ScreenLayer zIndex={15} colors={colors} paddingTop={insets.top} paddingBottom={insets.bottom} paddingLeft={insets.left} paddingRight={insets.right}>
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
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
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

  if (missingTrackRelocation.locateTarget) {
    return (
      <>
        <AppStatusBar barStyle={statusBarStyle} />
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
          <LocateMissingFileScreen
            colors={colors}
            missingTrackName={trackDisplayName(missingTrackRelocation.locateTarget.track)}
            candidates={missingTrackRelocation.candidates}
            relocating={missingTrackRelocation.relocating}
            onSelect={(file) => void missingTrackRelocation.selectCandidate(file)}
            onCancel={missingTrackRelocation.cancelLocate}
          />
        </View>
      </>
    );
  }

  if (createPlaylistRootId) {
    const root = grantedRoots.find((r) => r.id === createPlaylistRootId);
    return (
      <>
        <AppStatusBar barStyle={statusBarStyle} />
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
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
      </>
    );
  }

  if (createPlaylistTarget) {
    return (
      <>
        <AppStatusBar barStyle={statusBarStyle} />
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
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
      </>
    );
  }

  // closePlaylistScreen is shared between this back button and
  // useBackNavigation's closePlaylist action above - see
  // apps/web/src/App.tsx's identical helper.
  const closePlaylistScreen = () => {
    openLibrary();
    persistPlaybackPatch({ openedPlaylistId: null, openedRootId: null });
  };

  // Builds a virtual, never-persisted PlaylistRecord and opens it through
  // the exact same screen/persistence path as a real playlist - see
  // apps/web/src/App.tsx's identical helper for why (the individual
  // tracks themselves DO get persisted; only the playlist grouping is
  // recomputed fresh every time).
  const handleShowUnplaylisted = (rootId: string) => showUnplaylisted(rootId, { onOpened: persistOpenedPlaylist });

  // See apps/web/src/App.tsx's identical block for why this is scoped to
  // just the Unplaylisted virtual playlist.
  const isUnplaylistedScreen = screen.kind === 'playlist' && screen.playlist.id === `virtual:${screen.root.id}:unplaylisted`;
  // Gates TrackList's reorder mode and "Edit raw" button - both write to a
  // real .m3u8, which neither virtual playlist (Unplaylisted, Now Playing)
  // has one of. See apps/web/src/App.tsx's identical block.
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

  // Split into two independent elements rather than one screenContent
  // picked by screen.kind - see apps/web/src/App.tsx's identical split for
  // why (medium/wide tiers need library and playlist as separate
  // simultaneous panes).
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
          initialNumToRender={20}
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
        isAddingFolder={isAddingFolder}
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
        errorAction={
          needsAllFilesAccess && (
            <Pressable style={[styles.grantAccessButton, { backgroundColor: colors.accent }]} onPress={openAllFilesAccessSettings}>
              <Text style={styles.grantAccessButtonText}>Open Settings</Text>
            </Pressable>
          )
        }
        headerRight={paneHeaderActionsEl}
        secondaryAddButton={
          <FolderPickerButton colors={colors} icon={mdiSubtitles} text="Add Lyrics Folder" onPress={addLyricsFolder} />
        }
        lyricsSection={
          <LyricsFolderSection
            colors={colors}
            scopes={lyricsScopes}
            rootDisplayName={(rootId) => grantedRoots.find((r) => r.id === rootId)?.displayName ?? toRelativeDisplay(rootId)}
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

  return (
    <>
      <AppStatusBar barStyle={statusBarStyle} />
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
        {__DEV__ && SHOW_MEMORY_OVERLAY && <MemoryOverlay />}
        {tier === 'narrow' ? (
          <>
            <View style={styles.screenArea}>{playlistPaneContent ?? libraryPaneContent}</View>
            {nowPlayingScreen}
          </>
        ) : (
          <View style={styles.screenArea}>
            <MultiPaneLayout tier={tier} colors={colors} libraryPane={libraryPaneContent} playlistPane={playlistPaneContent} nowPlayingPane={nowPlayingContent} />
          </View>
        )}
        {miniPlayerBar}
        {settingsScreen}
        {externalConnectionsScreen}
        {editPlaylistFileScreen}
        {missingFileDialog}
        {addToPlaylistDialog}
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
  notice: {
    marginTop: 12,
    marginHorizontal: 16,
    fontSize: 13,
  },
  backRow: {
    width: '100%',
    maxWidth: 480,
  },
});

export default App;

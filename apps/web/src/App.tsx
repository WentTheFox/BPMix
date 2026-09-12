import type { FileRef, GrantedRoot, LoopMode, LyricsScope, PlaylistPlayerState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import {
  createBackgroundFileAccess,
  ensureTrackAnalyzed,
  errorMessage,
  FileAccessPermissionPendingError,
  formatTrackTitle,
  logLibraryAction,
  LYRICS_MATCHED_COUNT_SETTING_KEY,
  matchLibraryLyrics,
  PlaylistPlayer,
  scanLibraryMetadata,
  scanRoot,
} from '@bpmix/core';
import {
  BackButton,
  FolderPickerButton,
  HeaderActions,
  getAccentColorHex,
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
  useDoublePressHandler,
  useMemoryUsageLogging,
  useNotificationCenter,
  RAPID_PLAYBACK_PATCH_DEBOUNCE_MS,
  useBackNavigation,
  usePlaybackPersistence,
  useRestoringProgress,
  useThemeColors,
} from '@bpmix/ui';
import type { RootWithLibrary } from '@bpmix/ui';
import { mdiSubtitles } from '@mdi/js';
import type { CSSProperties, ReactNode } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { DimensionValue } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createAudioEngine } from './adapters/audioEngine';
import { createCoverArtResizer } from './adapters/coverArtResizer';
import { createCompositeFileAccess, isServerBackendAvailable } from './adapters/fileAccess.composite';
import { createLibraryStore } from './adapters/libraryStore';
import { useMediaSessionNotification } from './adapters/mediaSessionNotification';
import { isRunningInstalled, promptInstall, usePwaInstallAvailable } from './adapters/pwaInstall';

const TRANSPORT_THROTTLE_MS = 300;
// How long the metadata-scan notification's "done" state stays visible
// before it dismisses itself - long enough to actually read, not so long it
// lingers as clutter once there's nothing left to do about it.
const METADATA_SCAN_AUTO_DISMISS_MS = 4000;
// Only used to construct playlistPlayer below, before any component (and
// its settings) exists - useAppSettings' own default and this must agree,
// since App's crossfadeSeconds effect only re-syncs playlistPlayer once
// settings finish loading from storage.
const DEFAULT_CROSSFADE_SECONDS = 8;

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
      void ensureTrackAnalyzed(libraryStore, ref, decoded);
      reportFileFound(ref.id);
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
  const { settings, updateSettings, resetSettings } = useAppSettings(libraryStore);
  const colors = useThemeColors(settings.themeMode, getAccentColorHex(settings.accentColor));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rootsWithLibrary, setRootsWithLibrary] = useState<RootWithLibrary[]>([]);
  const [grantedRoots, setGrantedRoots] = useState<GrantedRoot[]>([]);
  const [lyricsScopes, setLyricsScopes] = useState<LyricsScope[]>([]);
  const [matchedLyricsCount, setMatchedLyricsCount] = useState<number | null>(null);
  const [busyLyricsScopeKey, setBusyLyricsScopeKey] = useState<string | null>(null);
  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Everything that used to be a one-shot setError(errorMessage(err)) string
  // (playback/decode failures specifically) now goes here instead - see
  // NotificationBell's doc for why a raw error string as the *entire*
  // message ("A requested file or directory could not be found...") wasn't
  // good enough on its own. `error`/setError above is left alone for the
  // handful of direct-action error paths (addFolder, rescan, etc.) that
  // still want an immediate, action-adjacent inline message.
  const notificationCenter = useNotificationCenter();
  // fileIds whose most recent decode attempt failed - TrackRow reads this to
  // show a missing-file indicator instead of pretending everything's fine
  // until the user taps play and it silently does nothing.
  const [missingFileIds, setMissingFileIds] = useState<Set<string>>(new Set());
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
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  // Opened by tapping MiniPlayerBar's art/title area - closes back to
  // whichever screen (library or playlist) was already showing underneath.
  const [nowPlayingScreenOpen, setNowPlayingScreenOpen] = useState(false);
  const [playerState, setPlayerState] = useState<PlaylistPlayerState>(playlistPlayer.getState());
  // Distinguishes "merely restored on launch" from "actually played this
  // session" - see the mobile app's identical hasStartedPlayback for why:
  // gating the media session on currentFileId alone would surface OS/
  // browser media controls (and a playbackState) on every page load,
  // whether or not anything was ever actually played, since the restore
  // path decodes the last track silently without autoplaying it.
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  useEffect(() => {
    if (playerState.track.status === 'playing') setHasStartedPlayback(true);
  }, [playerState.track.status]);

  useMemoryUsageLogging(playerState.track.status !== 'idle');

  // Same close-priority order as the mobile app (see useBackNavigation's
  // doc) - Settings, then Now Playing, then Playlist back to Library, then
  // (nothing left of ours to close) the browser's own back behavior of
  // leaving the page.
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

  const refresh = useCallback(async () => {
    advanceStep('listingFolders');
    const roots = await fileAccess.listGrantedRoots();
    setGrantedRoots(roots);
    advanceStep('scanningLibrary');

    // Each root's scan is isolated in its own try/catch - one bad root
    // (a moved/deleted folder, a native file-access error) used to reject
    // this whole Promise.all before setRootsWithLibrary ever ran, which
    // blanked the ENTIRE library (every other, perfectly fine root included)
    // on every refresh/relaunch until the bad root was manually removed.
    // Now a failing root just reports its own error and drops out, leaving
    // the rest of the library visible.
    const withLibrary = (
      await Promise.all(
        // A 'lyrics' root (see GrantedRoot.kind's doc) is never a music
        // library - it's a lyrics-only folder granted via addLyricsFolder's
        // own requestRoot('lyrics') call, and scanning/listing it here would
        // just show a permanently-empty "library" entry for it.
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
                // having a volume mounted. Scan it now instead of silently
                // showing an empty library until the user notices and clicks
                // Rescan themselves. Uses backgroundFileAccess, not fileAccess -
                // refresh() itself runs automatically (on mount, after restore)
                // with no user gesture behind it, same reasoning as
                // matchLibraryLyrics/scanLibraryMetadata above.
                await scanRoot(backgroundFileAccess, libraryStore, root.id);
                [playlists, tracks] = await Promise.all([
                  libraryStore.listPlaylists(root.id),
                  libraryStore.listTracks(root.id),
                ]);
              }
              return { root, playlists, tracksById: new Map(tracks.map((t) => [t.fileId, t])) };
            } catch (err) {
              // A lapsed browser grant can't be re-requested from this
              // non-gesture scan (see FileAccessCallOptions.allowPrompt's doc)
              // - this root just stays empty until a real click (Rescan,
              // re-adding the folder) re-grants it, rather than surfacing the
              // browser's raw permission-error text as if it were a real bug.
              if (!(err instanceof FileAccessPermissionPendingError)) {
                setError(errorMessage(err));
                logLibraryAction('refresh:rootFailed', { rootId: root.id, error: String(err) });
              }
              return null;
            }
          }),
      )
    ).filter((entry): entry is RootWithLibrary => entry !== null);
    setRootsWithLibrary(withLibrary);

    // Lyrics scopes are subfolders of an already-granted root (see
    // LyricsScope's doc), so this doesn't need its own root list at all -
    // just walk each configured scope for .lrc files.
    const scopes = await libraryStore.getLyricsScopes();
    setLyricsScopes(scopes);
    setHasLyricsScopes(scopes.length > 0);

    // Auto-assign any track that doesn't already have a lyrics match (an
    // existing manual override is never overwritten here - getLyricsAssignment
    // returning non-null short-circuits before findAutoLyricsMatch runs).
    // Recomputed on every refresh rather than cached, since a lyrics scope's
    // contents can change between scans same as a music root's can.
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
      void matchLibraryLyrics(backgroundFileAccess, libraryStore, scopes, allTracks, {
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
    // environment is single-threaded, and this doesn't run in a browser tab
    // that could use a real Web Worker), so it only touches the JS thread
    // during actual idle gaps instead of competing with whatever brought
    // the user to this screen. No InteractionManager.runAfterInteractions
    // wrapper needed here anymore - that API is deprecated on this RN
    // version, and requestIdle already defers past the current interaction
    // on its own.
    void scanLibraryMetadata(backgroundFileAccess, libraryStore, withLibrary.flatMap(({ tracksById }) => [...tracksById.values()]), {
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
    // refresh() call itself, a manual "Rescan", or a folder sync tool
    // dropping in a new file) since playback started - reconcile
    // PlaylistPlayer's running order against whatever this fresh scan
    // found instead of leaving it stale until the user happens to reopen
    // the playlist (see reconcilePlaylist's doc for why a plain
    // setPlaylist() reload isn't used here - it would restart shuffle/
    // position bookkeeping).
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
    // notificationCenter.upsertProgress specifically (not the whole
    // notificationCenter object) - that one property is a stable
    // useCallback reference regardless of the notification list itself
    // changing, unlike the wrapper object useNotificationCenter returns
    // (memoized with `notifications` as a dep) - depending on the whole
    // object here would recreate refresh (and, downstream, retrigger
    // usePlaybackPersistence's restore effect, which depends on refresh)
    // every single time a notification is added/dismissed anywhere in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationCenter.upsertProgress]);

  const { isRestoring, persistPlaybackPatch, persistPositionIfDue, notifyUserTookOver } = usePlaybackPersistence({
    fileAccess,
    backgroundFileAccess,
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

  // Double-click invocation guarding (e.g. against opening two concurrent
  // native folder-picker prompts, observed on Windows to leave the WinRT
  // broker in a bad state and surface later as an unrelated-looking "file
  // in use" error during a scan) lives in FolderPickerButton (packages/ui)
  // now, not here - this is just the plain pick-and-handle operation it
  // wraps.
  const addFolder = useCallback(async () => {
    setError(null);
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

  // A real, independent OS directory picker (requestRoot('lyrics')) rather
  // than FolderBrowser over an already-granted music root - the old
  // subfolder-only flow existed only because every granted root used to be
  // unconditionally scanned as a music library (refresh() below), which
  // would've left a phantom empty "library" entry for a lyrics-only root.
  // GrantedRoot.kind now lets refresh() skip exactly that, so this can just
  // grant its own root like addFolder does.
  const addLyricsFolder = useCallback(async () => {
    setError(null);
    try {
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
        // too rather than leave an orphaned grant sitting in IndexedDB
        // forever with nothing in the UI ever referencing it again. A root
        // still used for music, or still holding another lyrics scope,
        // is left alone.
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
  }, [playerState.track.isAudible, persistPlaybackPatch]);

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
  }, [persistPlaybackPatch]);

  const goPrevious = useCallback(async (options?: { force?: boolean }) => {
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
    // zIndex + backgroundColor here must beat/cover HeaderRow's own zIndex
    // (1, see its doc) - without an explicit, higher zIndex, the playlist/
    // library screen underneath's own HeaderRow (its back-row title +
    // NotificationBell) painted ABOVE this whole overlay despite being
    // mounted earlier: a nested descendant's zIndex doesn't just win among
    // its own siblings, it also outranks an ancestor-level sibling with no
    // zIndex of its own - confirmed on the mobile app as two overlapping
    // header rows/bells ("Playlist: In Order" bleeding through "Now
    // Playing"'s own header). Also needed an explicit background (missing
    // here, unlike mobile's equivalent wrapper) since NowPlayingScreen's
    // own container has none either - without one this overlay was fully
    // transparent on web, which would show the exact same bleed-through
    // for the WHOLE screen, not just the header band.
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, zIndex: 10 }]}>
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
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, zIndex: 20 }]}>
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
      <RestoringScreen colors={colors} completedSteps={completedSteps} currentStep={currentStep} hasLyricsScopes={hasLyricsScopes} />
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
          initialNumToRender={30}
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
        isAddingFolder={busyRootId !== null && !rootsWithLibrary.some(({ root }) => root.id === busyRootId)}
        onAddFolder={addFolder}
        onRescan={rescan}
        onRemoveRoot={(rootId) => void removeRoot(rootId)}
        onSelectPlaylist={(root, playlist, tracksById) => setScreen({ kind: 'playlist', root, playlist, tracksById })}
        error={error}
        listStyle={styles.list}
        headerRight={<HeaderActions colors={colors} center={notificationCenter} onOpenSettings={() => setSettingsOpen(true)} />}
        secondaryAddButton={
          <FolderPickerButton colors={colors} icon={mdiSubtitles} text="Add Lyrics Folder" onPress={addLyricsFolder} />
        }
        bannerContent={
          <>
            {!SUPPORTS_DIRECTORY_PICKER && (
              <Text style={styles.warning}>
                This browser can't pick local folders. Use the self-hosted Docker server instead to browse a mounted music
                library -{' '}
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
                  so often, but an installed app doesn't.
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
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.screenArea}>{screenContent}</View>
      {miniPlayerBar}
      {nowPlayingScreen}
      {settingsScreen}
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

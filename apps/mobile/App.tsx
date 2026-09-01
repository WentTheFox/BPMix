/**
 * BPMix - Stage 2: single-track playback (play/pause/seek/stop), on top of
 * Stage 1's folder scanning.
 * @format
 */

import type { FileRef, GrantedRoot, PlaylistRecord, TrackPlayerState, TrackRecord } from '@bpmix/core';
import { scanRoot, TrackPlayer } from '@bpmix/core';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { createAudioEngine } from './src/adapters/audioEngine';
import { createFileAccess } from './src/adapters/fileAccess';
import { createLibraryStore } from './src/adapters/libraryStore';

const fileAccess = createFileAccess();
const libraryStore = createLibraryStore();
const audioEngine = createAudioEngine(fileAccess);
const trackPlayer = new TrackPlayer(audioEngine);

interface RootWithLibrary {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
  tracksById: Map<string, TrackRecord>;
}

type Screen =
  | { kind: 'library' }
  | { kind: 'playlist'; root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };

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

function AppContent() {
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === 'dark';
  const colors = isDarkMode ? darkColors : lightColors;
  const [rootsWithLibrary, setRootsWithLibrary] = useState<RootWithLibrary[]>([]);
  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  const [nowPlayingFileId, setNowPlayingFileId] = useState<string | null>(null);
  const [nowPlayingName, setNowPlayingName] = useState<string>('');
  const [playerState, setPlayerState] = useState<TrackPlayerState>({
    status: 'idle',
    positionSeconds: 0,
    durationSeconds: 0,
  });
  const loadTokenRef = useRef(0);

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
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(String(err)));
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => setPlayerState(trackPlayer.getState()), 200);
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

  const playTrack = useCallback(
    async (track: TrackRecord) => {
      setError(null);
      if (nowPlayingFileId === track.fileId) {
        trackPlayer.play();
        setPlayerState(trackPlayer.getState());
        return;
      }
      const token = ++loadTokenRef.current;
      try {
        setNowPlayingFileId(track.fileId);
        setNowPlayingName(trackDisplayName(track));
        await trackPlayer.load(trackToFileRef(track));
        if (loadTokenRef.current !== token) return; // a newer play() call superseded this one
        trackPlayer.play();
        setPlayerState(trackPlayer.getState());
      } catch (err) {
        setError(String(err));
      }
    },
    [nowPlayingFileId],
  );

  const togglePause = useCallback(() => {
    if (playerState.status === 'playing') {
      trackPlayer.pause();
    } else {
      trackPlayer.play();
    }
    setPlayerState(trackPlayer.getState());
  }, [playerState.status]);

  const stop = useCallback(() => {
    trackPlayer.stop();
    setPlayerState(trackPlayer.getState());
  }, []);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      trackPlayer.seek(playerState.positionSeconds + deltaSeconds);
      setPlayerState(trackPlayer.getState());
    },
    [playerState.positionSeconds],
  );

  const nowPlayingBar = nowPlayingFileId && (
    <View style={styles.nowPlaying}>
      <Text style={[styles.nowPlayingName, { color: colors.text }]} numberOfLines={1}>
        {nowPlayingName}
      </Text>
      <Text style={[styles.nowPlayingTime, { color: colors.subtleText }]}>
        {formatSeconds(playerState.positionSeconds)} / {formatSeconds(playerState.durationSeconds)} (
        {playerState.status})
      </Text>
      <View style={styles.transportRow}>
        <Pressable style={styles.transportButton} onPress={() => seekBy(-10)}>
          <Text style={styles.transportButtonText}>-10s</Text>
        </Pressable>
        <Pressable style={styles.transportButton} onPress={togglePause}>
          <Text style={styles.transportButtonText}>{playerState.status === 'playing' ? 'Pause' : 'Play'}</Text>
        </Pressable>
        <Pressable style={styles.transportButton} onPress={() => seekBy(10)}>
          <Text style={styles.transportButtonText}>+10s</Text>
        </Pressable>
        <Pressable style={styles.transportButton} onPress={stop}>
          <Text style={styles.transportButtonText}>Stop</Text>
        </Pressable>
      </View>
    </View>
  );

  if (screen.kind === 'playlist') {
    const { playlist, tracksById } = screen;
    return (
      <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
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
                isCurrent={nowPlayingFileId === fileId}
                isPlaying={playerState.status === 'playing'}
                colors={colors}
                onPress={playTrack}
              />
            );
          }}
          initialNumToRender={20}
          windowSize={7}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
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
    alignItems: 'center',
    paddingTop: 24,
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
  trackRow: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  trackName: {
    fontSize: 14,
  },
});

export default App;

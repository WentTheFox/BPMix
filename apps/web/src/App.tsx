import type { GrantedRoot, PlaylistRecord } from '@bpmix/core';
import { scanRoot } from '@bpmix/core';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { createFileAccess } from './adapters/fileAccess';
import { createLibraryStore } from './adapters/libraryStore';

const fileAccess = createFileAccess();
const libraryStore = createLibraryStore();

interface RootWithPlaylists {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
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

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const colors = isDarkMode ? darkColors : lightColors;
  const [rootsWithPlaylists, setRootsWithPlaylists] = useState<RootWithPlaylists[]>([]);
  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const roots = await fileAccess.listGrantedRoots();
    const withPlaylists = await Promise.all(
      roots.map(async (root) => ({ root, playlists: await libraryStore.listPlaylists(root.id) })),
    );
    setRootsWithPlaylists(withPlaylists);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(String(err)));
  }, [refresh]);

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

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.text }]}>BPMix</Text>
      <Pressable style={styles.button} onPress={addFolder}>
        <Text style={styles.buttonText}>Add Folder</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
      <ScrollView style={styles.list}>
        {rootsWithPlaylists.map(({ root, playlists }) => (
          <View key={root.id} style={styles.rootSection}>
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
              <View key={playlist.id} style={styles.playlist}>
                <Text style={[styles.playlistName, { color: colors.text }]}>{playlist.name}</Text>
                <Text style={[styles.trackCount, { color: colors.subtleText }]}>
                  {playlist.trackFileIds.length} track(s)
                </Text>
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: '100vh',
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

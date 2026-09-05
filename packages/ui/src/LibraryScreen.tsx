import type { GrantedRoot, PlaylistRecord, TrackRecord } from '@bpmix/core';
import { mdiFolder, mdiFolderPlus, mdiPlaylistMusic, mdiRefresh } from '@mdi/js';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppTitle } from './AppTitle';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';
// Same shape usePlaybackPersistence's refresh() already returns - reused
// rather than redeclared (and re-exported from there, not here, to avoid
// index.ts exporting the same name from two modules) so the two can't drift
// out of sync with each other.
import type { RootWithLibrary } from './usePlaybackPersistence';

export interface LibraryScreenProps {
  colors: Colors;
  rootsWithLibrary: RootWithLibrary[];
  busyRootId: string | null;
  /**
   * Mobile-only: disables the Add Folder button and swaps its label for a
   * spinner while a brand-new root's first scan is in flight (see mobile
   * App.tsx's isAddingFolder). Web has never gated this - `undefined`/false
   * renders the plain button on both.
   */
  isAddingFolder?: boolean;
  onAddFolder: () => void;
  onRescan: (rootId: string) => void;
  onSelectPlaylist: (root: GrantedRoot, playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>) => void;
  error?: string | null;
  /** Rendered where each app's now-playing bar goes - still owned by the caller, just slotted in at the right point in the layout. */
  nowPlayingBar?: ReactNode;
  /** Web-only directory-picker-unsupported warning, rendered right after the Add Folder button. */
  bannerContent?: ReactNode;
  /** The lyrics-folder section (see LyricsFolderSection), rendered right after bannerContent. */
  lyricsSection?: ReactNode;
  /**
   * Merged onto the roots FlatList's own style - web adds flex:1 here so it
   * has a bounded-height ancestor to actually virtualize against (see web
   * App.tsx's container/list style comments); mobile has no such need.
   */
  listStyle?: StyleProp<ViewStyle>;
}

/**
 * The library home screen shared between mobile and web: title, Add Folder
 * button, an optional platform banner slot, and the scanned roots'
 * playlists. Extracted because this exact shape (including the rescan
 * link's per-root busy state) had drifted into two separately-maintained
 * copies - see CLAUDE.md's convention note on apps/mobile/App.tsx and
 * apps/web/src/App.tsx.
 */
export function LibraryScreen({
  colors,
  rootsWithLibrary,
  busyRootId,
  isAddingFolder = false,
  onAddFolder,
  onRescan,
  onSelectPlaylist,
  error,
  nowPlayingBar,
  bannerContent,
  lyricsSection,
  listStyle,
}: LibraryScreenProps) {
  return (
    <>
      <AppTitle color={colors.text} />
      <Pressable style={[styles.button, isAddingFolder && styles.buttonDisabled]} onPress={onAddFolder} disabled={isAddingFolder}>
        {isAddingFolder ? (
          <View style={styles.buttonRow}>
            <ActivityIndicator color="#fff" style={styles.buttonSpinner} />
            <Text style={styles.buttonText}>Scanning folder…</Text>
          </View>
        ) : (
          <IconLabel path={mdiFolderPlus} text="Add Folder" color="white" iconSize={18} textStyle={styles.buttonText} />
        )}
      </Pressable>
      {bannerContent}
      {lyricsSection}
      {error && <Text style={styles.error}>{error}</Text>}
      {nowPlayingBar}
      <FlatList
        style={[styles.list, listStyle]}
        data={rootsWithLibrary}
        keyExtractor={({ root }) => root.id}
        renderItem={({ item: { root, playlists, tracksById } }) => (
          <View style={styles.rootSection}>
            <View style={styles.rootHeader}>
              <IconLabel path={mdiFolder} text={root.displayName} color={colors.text} iconSize={18} textStyle={styles.rootName} />
              <Pressable onPress={() => onRescan(root.id)} disabled={busyRootId === root.id}>
                {busyRootId === root.id ? (
                  <Text style={styles.rescanLink}>Scanning…</Text>
                ) : (
                  <IconLabel path={mdiRefresh} text="Rescan" color="#3b82f6" iconSize={16} textStyle={styles.rescanLink} />
                )}
              </Pressable>
            </View>
            {playlists.length === 0 && <Text style={[styles.empty, { color: colors.subtleText }]}>No playlists found yet.</Text>}
            {playlists.map((playlist) => (
              <Pressable key={playlist.id} style={styles.playlist} onPress={() => onSelectPlaylist(root, playlist, tracksById)}>
                <IconLabel path={mdiPlaylistMusic} text={playlist.name} color={colors.text} iconSize={16} textStyle={styles.playlistName} />
                <Text style={[styles.trackCount, { color: colors.subtleText }]}>{playlist.trackFileIds.length} track(s)</Text>
              </Pressable>
            ))}
          </View>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
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

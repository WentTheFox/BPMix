import type { GrantedRoot, PlaylistRecord, TrackRecord } from '@bpmix/core';
import { mdiFolder, mdiFolderMusic, mdiPlaylistMusic, mdiRefresh } from '@mdi/js';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { AddFolderButton } from './AddFolderButton';
import { AppTitle } from './AppTitle';
import { IconLabel } from './IconLabel';
import { RemoveButton } from './RemoveButton';
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
  /** Revokes the root's grant and drops it from the library screen - if omitted, no Remove action is shown for roots. */
  onRemoveRoot?: (rootId: string) => void;
  onSelectPlaylist: (root: GrantedRoot, playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>) => void;
  error?: string | null;
  /** Rendered right after the error text - e.g. a "Grant Access" button for Android's AllFilesAccessRequiredError, so the user doesn't have to find Settings on their own. */
  errorAction?: ReactNode;
  /** Rendered in a row right next to the Add Folder button - the "Add Lyrics Folder" AddFolderButton, so the two sit side by side instead of stacked. */
  secondaryAddButton?: ReactNode;
  /** Web-only directory-picker-unsupported warning, rendered right after the button row. */
  bannerContent?: ReactNode;
  /** The lyrics-folder scopes list (see LyricsFolderSection), rendered right after bannerContent. */
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
  onRemoveRoot,
  onSelectPlaylist,
  error,
  errorAction,
  secondaryAddButton,
  bannerContent,
  lyricsSection,
  listStyle,
}: LibraryScreenProps) {
  return (
    <>
      <AppTitle color={colors.text} />
      <View style={styles.addButtonRow}>
        <AddFolderButton icon={mdiFolderMusic} text="Add Folder" onPress={onAddFolder} busy={isAddingFolder} busyText="Scanning folder…" />
        {secondaryAddButton}
      </View>
      {bannerContent}
      {lyricsSection}
      {error && <Text style={styles.error}>{error}</Text>}
      {errorAction}
      <FlatList
        style={[styles.list, listStyle]}
        data={rootsWithLibrary}
        keyExtractor={({ root }) => root.id}
        renderItem={({ item: { root, playlists, tracksById } }) => (
          <View style={styles.rootSection}>
            <View style={styles.rootHeader}>
              <IconLabel
                path={mdiFolder}
                text={root.displayName}
                color={colors.text}
                iconSize={18}
                textStyle={styles.rootName}
                containerStyle={styles.rootNameContainer}
                numberOfLines={1}
                ellipsizeMode="middle"
              />
              <View style={styles.rootActions}>
                <Pressable onPress={() => onRescan(root.id)} disabled={busyRootId === root.id}>
                  {busyRootId === root.id ? (
                    <Text style={styles.rescanLink}>Scanning…</Text>
                  ) : (
                    <IconLabel path={mdiRefresh} text="Rescan" color="#3b82f6" iconSize={16} textStyle={styles.rescanLink} />
                  )}
                </Pressable>
                {onRemoveRoot && <RemoveButton onConfirm={() => onRemoveRoot(root.id)} />}
              </View>
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
  addButtonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
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
  rootActions: {
    flexDirection: 'row',
    flexShrink: 0,
    alignItems: 'center',
    gap: 12,
  },
  // minWidth: 0 - see LyricsFolderSection's scopeNameContainer for why this
  // (not flexShrink on the text alone) is what actually lets a long root
  // name truncate instead of overflowing past Rescan/Remove.
  rootNameContainer: {
    flex: 1,
    minWidth: 0,
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

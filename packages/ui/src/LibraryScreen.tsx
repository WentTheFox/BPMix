import type { GrantedRoot, PlaylistRecord, TrackRecord } from '@bpmix/core';
import { mdiFolder, mdiFolderMusic, mdiMusicNote, mdiPlay, mdiPlaylistMusic, mdiRefresh } from '@mdi/js';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppTitle } from './AppTitle';
import { AutomaticPlaylistRow } from './AutomaticPlaylistRow';
import { CreatePlaylistButton } from './CreatePlaylistButton';
import { FolderPickerButton } from './FolderPickerButton';
import { HeaderRow } from './HeaderRow';
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
  /**
   * Disables the Add Folder button and swaps its label for a spinner while
   * a brand-new root's first scan is in flight (see App.tsx's
   * isAddingFolder). `undefined`/false renders the plain button. The
   * button is also disabled (without the spinner/label swap) whenever its
   * native folder-picker prompt is open, regardless of this prop - see
   * FolderPickerButton's doc.
   */
  isAddingFolder?: boolean;
  /**
   * True until the initial background refresh (see App.tsx's isLoadingRoots
   * doc) resolves rootsWithLibrary at least once. Shows a "Loading your
   * library…" placeholder instead of a bare empty list - without it, the
   * first few seconds after launch (RestoringScreen dismisses well before
   * this finishes, especially for a self-hosted server root needing a real
   * HTTP round trip) looked identical to "no folders added yet".
   */
  isLoadingRoots?: boolean;
  /**
   * True while rootId is being scanned by ANY caller, not just this
   * screen's own Rescan click - an automatic background refresh can also
   * be scanning a root right now (see useLibraryRootActions.isRootScanning's
   * doc). Shows "Scanning…" in place of the Rescan action and disables it,
   * so a click can't fire a second concurrent scan of a root that's already
   * mid-scan for an unrelated reason. Cancelling an in-flight scan is done
   * from the notification bell (see App.tsx's scanning-notification effect),
   * not from here - a scan can run long enough to want cancelling from
   * whichever screen the user's actually looking at, not just this one.
   */
  isRootScanning: (rootId: string) => boolean;
  onAddFolder: () => Promise<void>;
  onRescan: (rootId: string) => void;
  /** Revokes the root's grant and drops it from the library screen - if omitted, no Remove action is shown for roots. */
  onRemoveRoot?: (rootId: string) => void;
  /** Opens the create-playlist-from-folder flow (see CreatePlaylistScreen) scoped to this root - if omitted, no "New Playlist" action is shown for roots. */
  onCreatePlaylist?: (rootId: string) => void;
  /** Walks this root for every audio file no current playlist references and opens the result as an ordinary playlist screen (see findUnplaylistedTracks) - if omitted, no "Unplaylisted" row is shown for roots. Rendered under a per-root "Automatic" heading, alongside "Now Playing" (below) when that's also present for the same root. */
  onShowUnplaylisted?: (rootId: string) => Promise<void>;
  /** rootId of whatever's actually playing right now, or null if nothing has played yet this session (see App.tsx's playingContext) - the "Now Playing" automatic-playlist row only appears under that one root's section, since only one root can be playing at a time. */
  nowPlayingRootId?: string | null;
  /** Opens the "Now Playing" virtual playlist - mirrors the currently playing real playlist's order, or the live shuffle order instead if shuffle is on (see App.tsx's handleShowNowPlaying). Omitted along with nowPlayingRootId when nothing has played yet. */
  onShowNowPlaying?: () => void;
  /** id of the real PlaylistRecord actually playing right now (see App.tsx's playingContext), or null - highlights that one row in the plain playlists list below in the accent color, same idea as TrackRow's own now-playing highlight. A PlaylistRecord's id is its source .m3u8's own FileRef.id (see scan.ts), which already embeds enough (a root uuid on web, a full path on Android) to be globally unique - no need to also match rootId here. */
  nowPlayingPlaylistId?: string | null;
  onSelectPlaylist: (root: GrantedRoot, playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>) => void;
  error?: string | null;
  /** Rendered right after the error text - e.g. a "Grant Access" button for Android's AllFilesAccessRequiredError, so the user doesn't have to find Settings on their own. */
  errorAction?: ReactNode;
  /** Rendered in a row right next to the Add Folder button - the "Add Lyrics Folder" FolderPickerButton, so the two sit side by side instead of stacked. */
  secondaryAddButton?: ReactNode;
  /** Web-only directory-picker-unsupported warning, rendered right after the button row. */
  bannerContent?: ReactNode;
  /** The lyrics-folder scopes list (see LyricsFolderSection), rendered right after bannerContent. */
  lyricsSection?: ReactNode;
  /** Rendered right-aligned in the same row as the title - the NotificationBell, so it sits inline rather than floating over content below it. */
  headerRight?: ReactNode;
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
  isAddingFolder = false,
  isLoadingRoots = false,
  isRootScanning,
  onAddFolder,
  onRescan,
  onRemoveRoot,
  onCreatePlaylist,
  onShowUnplaylisted,
  nowPlayingRootId,
  onShowNowPlaying,
  nowPlayingPlaylistId,
  onSelectPlaylist,
  error,
  errorAction,
  secondaryAddButton,
  bannerContent,
  lyricsSection,
  headerRight,
  listStyle,
}: LibraryScreenProps) {
  return (
    <>
      <HeaderRow left={<AppTitle color={colors.text} accentColor={colors.accent} />} right={headerRight} />
      <View style={styles.addButtonRow}>
        <FolderPickerButton
          colors={colors}
          icon={mdiFolderMusic}
          text="Add Folder"
          onPress={onAddFolder}
          busy={isAddingFolder}
          busyText="Scanning folder…"
        />
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
        ListEmptyComponent={isLoadingRoots ? <Text style={[styles.empty, { color: colors.subtleText }]}>Loading your library…</Text> : null}
        renderItem={({ item: { root, playlists, tracksById } }) => (
          <View style={styles.rootSection}>
            <View style={styles.rootHeader}>
              <IconLabel
                path={mdiFolder}
                text={root.displayName}
                color={colors.text}
                iconSize={16}
                textStyle={styles.rootName}
                containerStyle={styles.rootNameContainer}
                numberOfLines={1}
                ellipsizeMode="middle"
              />
              <View style={styles.rootActions}>
                {isRootScanning(root.id) ? (
                  <Text style={{ color: colors.accent }}>Scanning…</Text>
                ) : (
                  <Pressable onPress={() => onRescan(root.id)}>
                    <IconLabel path={mdiRefresh} text="Rescan" color={colors.accent} iconSize={16} />
                  </Pressable>
                )}
                {onCreatePlaylist && <CreatePlaylistButton colors={colors} onConfirm={() => onCreatePlaylist(root.id)} />}
                {onRemoveRoot && root.removable !== false && <RemoveButton colors={colors} onConfirm={() => onRemoveRoot(root.id)} />}
              </View>
            </View>
            {playlists.length === 0 && <Text style={[styles.empty, { color: colors.subtleText }]}>No playlists found yet.</Text>}
            {playlists.map((playlist) => {
              const isNowPlaying = playlist.id === nowPlayingPlaylistId;
              return (
                <Pressable key={playlist.id} style={styles.playlist} onPress={() => onSelectPlaylist(root, playlist, tracksById)}>
                  <IconLabel
                    path={mdiPlaylistMusic}
                    text={playlist.name}
                    color={isNowPlaying ? colors.accent : colors.text}
                    iconSize={16}
                    textStyle={styles.playlistName}
                  />
                  <Text style={[styles.trackCount, { color: colors.subtleText }]}>{playlist.trackFileIds.length} track(s)</Text>
                </Pressable>
              );
            })}
            {(onShowNowPlaying && nowPlayingRootId === root.id) || onShowUnplaylisted ? (
              <View style={styles.automaticSection}>
                <Text style={[styles.automaticHeading, { color: colors.subtleText }]}>Automatic</Text>
                {onShowNowPlaying && nowPlayingRootId === root.id && (
                  <AutomaticPlaylistRow colors={colors} icon={mdiPlay} label="Now Playing" onPress={onShowNowPlaying} />
                )}
                {onShowUnplaylisted && (
                  <AutomaticPlaylistRow colors={colors} icon={mdiMusicNote} label="Unplaylisted" onPress={() => onShowUnplaylisted(root.id)} />
                )}
              </View>
            ) : null}
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
  // Matches LyricsFolderSection's scopeName (14px, regular) - both rows
  // show a folder path now (trimmed of the device's absolute storage
  // prefix - see fileAccess.android.ts's toRelativeDisplay - but still
  // long enough on a narrow screen that the previous 18px/600 here used to
  // clip against Rescan/Remove).
  rootName: {
    fontSize: 14,
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
  // Separated from the real playlists above it (marginTop, not just the
  // rows' own spacing) so it reads as a distinct group rather than a
  // continuation of the user's own curated playlist list.
  automaticSection: {
    marginTop: 12,
  },
  automaticHeading: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    opacity: 0.6,
  },
});

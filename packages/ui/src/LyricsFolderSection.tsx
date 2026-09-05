import type { GrantedRoot } from '@bpmix/core';
import { mdiFolder, mdiFolderPlus, mdiRefresh } from '@mdi/js';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface LyricsFolderSectionProps {
  colors: Colors;
  lyricsRoots: GrantedRoot[];
  /** How many of the currently loaded music tracks have a lyrics assignment (auto-matched or manually overridden) - null while a scan/match pass is still in flight. */
  matchedTrackCount: number | null;
  totalTrackCount: number;
  busyRootId: string | null;
  onAddLyricsFolder: () => void;
  onRescan: (rootId: string) => void;
}

/**
 * A dedicated-lyrics-folder root is granted the same way a music folder is
 * (FileAccess.requestRoot()), just tagged 'lyrics' via LibraryStore's
 * getRootKind/setRootKind so the app's startup scan doesn't try to treat it
 * as an (always empty) playlist root. Shared between mobile and web since
 * this exact shape - button, per-root rescan, a match-count summary - would
 * otherwise drift into two copies the way LibraryScreen's own roots list
 * once did (see CLAUDE.md's convention note on each app's App.tsx).
 *
 * Manual override of a single track's auto-matched lyrics file isn't wired
 * up yet - this only surfaces the aggregate match count for now.
 */
export function LyricsFolderSection({
  colors,
  lyricsRoots,
  matchedTrackCount,
  totalTrackCount,
  busyRootId,
  onAddLyricsFolder,
  onRescan,
}: LyricsFolderSectionProps) {
  return (
    <View style={styles.container}>
      <Pressable style={styles.button} onPress={onAddLyricsFolder}>
        <IconLabel path={mdiFolderPlus} text="Add Lyrics Folder" color="white" iconSize={18} textStyle={styles.buttonText} />
      </Pressable>
      {lyricsRoots.map((root) => (
        <View key={root.id} style={styles.rootRow}>
          <IconLabel path={mdiFolder} text={root.displayName} color={colors.text} iconSize={16} textStyle={styles.rootName} />
          <Pressable onPress={() => onRescan(root.id)} disabled={busyRootId === root.id}>
            {busyRootId === root.id ? (
              <Text style={styles.rescanLink}>Scanning…</Text>
            ) : (
              <IconLabel path={mdiRefresh} text="Rescan" color="#3b82f6" iconSize={14} textStyle={styles.rescanLink} />
            )}
          </Pressable>
        </View>
      ))}
      {lyricsRoots.length > 0 && totalTrackCount > 0 && (
        <Text style={[styles.summary, { color: colors.subtleText }]}>
          {matchedTrackCount == null ? 'Matching lyrics…' : `${matchedTrackCount} of ${totalTrackCount} track(s) have lyrics`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 12,
    width: '100%',
    maxWidth: 480,
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  buttonText: {
    color: 'white',
    fontWeight: '600',
  },
  rootRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  rootName: {
    fontSize: 14,
  },
  rescanLink: {
    color: '#3b82f6',
    fontSize: 12,
  },
  summary: {
    fontSize: 12,
    marginTop: 6,
    opacity: 0.8,
  },
});

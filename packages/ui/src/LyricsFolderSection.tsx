import type { LyricsScope } from '@bpmix/core';
import { mdiFolder, mdiFolderPlus, mdiRefresh } from '@mdi/js';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

/** Stable key for a scope - used for React keys and to track which one a busy/rescan indicator applies to. */
export function lyricsScopeKey(scope: Pick<LyricsScope, 'rootId' | 'relativePath'>): string {
  return `${scope.rootId}\n${scope.relativePath}`;
}

export interface LyricsFolderSectionProps {
  colors: Colors;
  scopes: LyricsScope[];
  /** Friendly display name for a scope's root (from the already-granted roots list) - falls back to the raw rootId if somehow missing. */
  rootDisplayName: (rootId: string) => string;
  /** How many of the currently loaded music tracks have a lyrics assignment (auto-matched or manually overridden) - null while a scan/match pass is still in flight. */
  matchedTrackCount: number | null;
  totalTrackCount: number;
  /** lyricsScopeKey() of whichever scope is currently rescanning, if any. */
  busyScopeKey: string | null;
  /** Starts the pick flow (choosing a root, then browsing to a subfolder within it) - owned by the caller since it needs a modal/screen, not just this section. */
  onAddLyricsFolder: () => void;
  onRemoveScope: (rootId: string, relativePath: string) => void;
  onRescan: (rootId: string, relativePath: string) => void;
}

/**
 * A lyrics scope is a subfolder of an ALREADY-granted root (relativePath ''
 * meaning the whole root), not a root of its own - see LyricsScope's doc for
 * why: requesting a brand-new top-level grant just for lyrics ran straight
 * into a broken Samsung "My Files" SAF picker that rejected every folder,
 * including freshly-created ones, while its own normal browse mode saw them
 * fine. Picking a scope (via FolderBrowser, over a root the user already
 * granted for music) never goes through that picker at all.
 *
 * Shared between mobile and web since this exact shape - button, per-scope
 * remove/rescan, a match-count summary - would otherwise drift into two
 * copies the way LibraryScreen's own roots list once did (see CLAUDE.md's
 * convention note on each app's App.tsx).
 *
 * Manual override of a single track's auto-matched lyrics file isn't wired
 * up yet - this only surfaces the aggregate match count for now.
 */
export function LyricsFolderSection({
  colors,
  scopes,
  rootDisplayName,
  matchedTrackCount,
  totalTrackCount,
  busyScopeKey,
  onAddLyricsFolder,
  onRemoveScope,
  onRescan,
}: LyricsFolderSectionProps) {
  return (
    <View style={styles.container}>
      <Pressable style={styles.button} onPress={onAddLyricsFolder}>
        <IconLabel path={mdiFolderPlus} text="Add Lyrics Folder" color="white" iconSize={18} textStyle={styles.buttonText} />
      </Pressable>
      {scopes.map((scope) => {
        const key = lyricsScopeKey(scope);
        const label = scope.relativePath ? `${rootDisplayName(scope.rootId)}/${scope.relativePath}` : rootDisplayName(scope.rootId);
        return (
          <View key={key} style={styles.scopeRow}>
            <IconLabel path={mdiFolder} text={label} color={colors.text} iconSize={16} textStyle={styles.scopeName} />
            <View style={styles.scopeActions}>
              <Pressable onPress={() => onRescan(scope.rootId, scope.relativePath)} disabled={busyScopeKey === key}>
                {busyScopeKey === key ? (
                  <Text style={styles.actionLink}>Scanning…</Text>
                ) : (
                  <IconLabel path={mdiRefresh} text="Rescan" color="#3b82f6" iconSize={14} textStyle={styles.actionLink} />
                )}
              </Pressable>
              <Pressable onPress={() => onRemoveScope(scope.rootId, scope.relativePath)}>
                <Text style={styles.removeLink}>Remove</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {scopes.length > 0 && totalTrackCount > 0 && (
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
  scopeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  scopeName: {
    fontSize: 14,
    flexShrink: 1,
  },
  scopeActions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionLink: {
    color: '#3b82f6',
    fontSize: 12,
  },
  removeLink: {
    color: '#dc2626',
    fontSize: 12,
  },
  summary: {
    fontSize: 12,
    marginTop: 6,
    opacity: 0.8,
  },
});

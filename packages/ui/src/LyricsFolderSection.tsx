import type { LyricsScope } from '@bpmix/core';
import { mdiFolder, mdiRefresh } from '@mdi/js';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';
import { RemoveButton } from './RemoveButton';
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
 * The "Add Lyrics Folder" button itself isn't rendered here - it's an
 * AddFolderButton the caller places in LibraryScreen's secondaryAddButton
 * slot instead, so it sits in a row next to "Add Folder" rather than
 * stacked below it. This component is just the resulting scopes list.
 *
 * Shared between mobile and web since this exact shape - per-scope
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
  onRemoveScope,
  onRescan,
}: LyricsFolderSectionProps) {
  if (scopes.length === 0) return null;

  return (
    <View style={styles.container}>
      {scopes.map((scope) => {
        const key = lyricsScopeKey(scope);
        const label = scope.relativePath ? `${rootDisplayName(scope.rootId)}/${scope.relativePath}` : rootDisplayName(scope.rootId);
        return (
          <View key={key} style={styles.scopeRow}>
            <IconLabel
              path={mdiFolder}
              text={label}
              color={colors.text}
              iconSize={18}
              textStyle={styles.scopeName}
              containerStyle={styles.scopeNameContainer}
              numberOfLines={1}
              ellipsizeMode="middle"
            />
            <View style={styles.scopeActions}>
              <Pressable onPress={() => onRescan(scope.rootId, scope.relativePath)} disabled={busyScopeKey === key}>
                {busyScopeKey === key ? (
                  <Text style={styles.actionLink}>Scanning…</Text>
                ) : (
                  <IconLabel path={mdiRefresh} text="Rescan" color="#3b82f6" iconSize={14} textStyle={styles.actionLink} />
                )}
              </Pressable>
              <RemoveButton onConfirm={() => onRemoveScope(scope.rootId, scope.relativePath)} />
            </View>
          </View>
        );
      })}
      {totalTrackCount > 0 && (
        <Text style={[styles.summary, { color: colors.subtleText }]}>
          {matchedTrackCount == null ? 'Matching lyrics…' : `${matchedTrackCount} of ${totalTrackCount} track(s) have lyrics`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 16,
    // Matches LibraryScreen's rootSection - this sits in the same unpadded
    // outer container, so without its own inset a scope row's Rescan/Remove
    // actions run flush to (and clip against) the physical screen edge.
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.3)',
    width: '100%',
    maxWidth: 480,
  },
  scopeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    gap: 12,
  },
  // minWidth: 0 is the actual fix - a row-flex child won't shrink below its
  // content's natural width without it, no matter what flexShrink says on
  // the child itself, so numberOfLines/ellipsizeMode above had nothing to
  // truncate against and the row just overflowed past Rescan/Remove.
  scopeNameContainer: {
    flex: 1,
    minWidth: 0,
  },
  scopeName: {
    fontSize: 18,
    fontWeight: '600',
  },
  scopeActions: {
    flexDirection: 'row',
    flexShrink: 0,
    gap: 12,
  },
  actionLink: {
    color: '#3b82f6',
    fontSize: 12,
  },
  summary: {
    fontSize: 12,
    marginTop: 10,
    opacity: 0.8,
  },
});

import type { LyricsScope } from '@bpmix/core';
import { mdiRefresh, mdiSubtitles } from '@mdi/js';
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
  /**
   * Whether a scope's Remove control should render at all - false for one
   * auto-registered from a non-removable root (see GrantedRoot.removable's
   * doc - currently just the self-hosted server's operator-mounted lyrics
   * roots). Removing the LyricsScope row would look like it worked, then
   * have refresh() silently re-add it on the very next pass since it's
   * still driven by that root's kind:'lyrics', so the control is hidden
   * instead of offered as a dead end. Defaults to always-removable when
   * omitted, matching every scope that predates this prop.
   */
  scopeRemovable?: (rootId: string) => boolean;
}

/**
 * A lyrics scope's rootId may be its own independent grant (web and Windows,
 * via requestRoot('lyrics') - see GrantedRoot.kind's doc) or, on Android, a
 * relativePath within the whole-device browse (no per-folder OS grant to
 * confine it to a subfolder of an already-added root there) - either way
 * this component only ever renders the resulting scope, never how it was
 * picked. Uses mdiSubtitles (not mdiFolder, which LibraryScreen's music
 * roots use) specifically so a scope row reads as "this is a lyrics
 * location" at a glance instead of looking like an ordinary library folder
 * with only the trailing match-count caption to tell them apart.
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
 * Manual override of a single track's auto-matched lyrics file is done from
 * the Now Playing screen instead (see LyricsSection/LyricsPickerScreen) -
 * this component only surfaces the aggregate match count and per-scope
 * rescan/remove actions.
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
  scopeRemovable,
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
              path={mdiSubtitles}
              text={label}
              color={colors.text}
              iconSize={16}
              textStyle={styles.scopeName}
              containerStyle={styles.scopeNameContainer}
              numberOfLines={1}
              ellipsizeMode="middle"
            />
            <View style={styles.scopeActions}>
              <Pressable onPress={() => onRescan(scope.rootId, scope.relativePath)} disabled={busyScopeKey === key}>
                {busyScopeKey === key ? (
                  <Text style={[styles.actionLink, { color: colors.accent }]}>Scanning…</Text>
                ) : (
                  <IconLabel path={mdiRefresh} text="Rescan" color={colors.accent} iconSize={14} textStyle={styles.actionLink} />
                )}
              </Pressable>
              {(scopeRemovable?.(scope.rootId) ?? true) && (
                <RemoveButton colors={colors} onConfirm={() => onRemoveScope(scope.rootId, scope.relativePath)} />
              )}
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
    fontSize: 14,
  },
  scopeActions: {
    flexDirection: 'row',
    flexShrink: 0,
    gap: 12,
  },
  actionLink: {
    fontSize: 12,
  },
  summary: {
    fontSize: 12,
    marginTop: 10,
    opacity: 0.8,
  },
});

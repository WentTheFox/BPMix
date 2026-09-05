import type { DirectoryEntry, FileAccess } from '@bpmix/core';
import { mdiArrowLeft, mdiFolder, mdiRefresh } from '@mdi/js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

// Substrings (not whole words) so "Playlists", "Songs", "Music", "Lyrics"
// etc. all match their singular/plural forms via a plain .includes() check.
const SUGGESTED_KEYWORDS = ['playlist', 'song', 'music', 'audio', 'media', 'lyric'];

function isSuggestedFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return SUGGESTED_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export interface FolderBrowserProps {
  colors: Colors;
  fileAccess: FileAccess;
  rootId: string;
  rootDisplayName: string;
  /** Where to start browsing - defaults to the root itself. */
  initialPath?: string;
  /** Fired with the relativePath the user landed on and confirmed - '' means the root itself. */
  onSelect: (relativePath: string) => void;
  onCancel: () => void;
  /**
   * Already-granted roots, as absolute paths in the same namespace as
   * `rootId` (Android's MANAGE_EXTERNAL_STORAGE whole-device browse only -
   * that's the one flow where a folder outside any existing grant can
   * still turn out to sit inside one on disk). A listed entry that's equal
   * to or nested inside one of these is greyed out and un-selectable, with
   * a note naming which root already covers it - picking it anyway would
   * scan the same files twice under two different library roots.
   */
  existingRoots?: { path: string; displayName: string }[];
}

function joinPath(base: string, relative: string): string {
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

function findCoveringRoot(
  entryPath: string,
  existingRoots: { path: string; displayName: string }[],
): { path: string; displayName: string } | undefined {
  return existingRoots.find((root) => entryPath === root.path || entryPath.startsWith(`${root.path.replace(/\/+$/, '')}/`));
}

/**
 * Navigates subfolders of an ALREADY-granted root via FileAccess.listDirectory
 * and lets the user pick one - the shared mechanism behind letting a user
 * choose separate music/lyrics subfolders under one grant, on every platform,
 * without ever requesting a second OS-level folder grant. That matters in
 * practice: a broken Samsung "My Files" SAF picker was rejecting every new
 * folder grant outright (including freshly-created ones) while its own
 * normal browse mode saw them fine - browsing within a root already granted
 * never goes through that picker at all, sidestepping the bug entirely
 * rather than working around it.
 */
export function FolderBrowser({ colors, fileAccess, rootId, rootDisplayName, initialPath, onSelect, onCancel, existingRoots }: FolderBrowserProps) {
  const [path, setPath] = useState(initialPath ?? '');
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (relativePath: string) => {
      setEntries(null);
      setError(null);
      try {
        const listed = await fileAccess.listDirectory(rootId, relativePath || undefined);
        setEntries(listed.filter((entry) => entry.type === 'directory'));
      } catch (err) {
        setError(String(err));
        setEntries([]);
      }
    },
    [fileAccess, rootId],
  );

  useEffect(() => {
    void load(path);
  }, [load, path]);

  // Never removed from `entries` below - this is just a quick-jump shortcut
  // to whatever in the current directory looks likely to be it, not a
  // filter on the real listing. Already-covered folders are dropped here
  // (rather than shown greyed out like a normal row) since jumping into
  // one only leads somewhere every entry is disabled anyway.
  const suggested = useMemo(
    () =>
      entries?.filter(
        (entry) => isSuggestedFolder(entry.name) && !(existingRoots?.length && findCoveringRoot(joinPath(rootId, entry.relativePath), existingRoots)),
      ) ?? [],
    [entries, existingRoots, rootId],
  );

  // rootDisplayName plus each non-empty path segment, each carrying the
  // relativePath a tap on it should jump back to.
  const segments = path ? path.split('/').filter(Boolean) : [];
  const crumbs = [
    { label: rootDisplayName, path: '' },
    ...segments.map((segment, index) => ({ label: segment, path: segments.slice(0, index + 1).join('/') })),
  ];

  const parentPath = segments.length > 0 ? segments.slice(0, -1).join('/') : null;
  const currentPathCovered = existingRoots?.length ? findCoveringRoot(joinPath(rootId, path), existingRoots) : undefined;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        {parentPath !== null && (
          <Pressable style={styles.upButton} onPress={() => setPath(parentPath)}>
            <Icon path={mdiArrowLeft} size={20} color={colors.text} />
          </Pressable>
        )}
        <View style={styles.breadcrumbRow}>
          {crumbs.map((crumb, index) => (
            <View key={crumb.path} style={styles.breadcrumbItem}>
              {index > 0 && <Text style={[styles.breadcrumbSeparator, { color: colors.subtleText }]}>/</Text>}
              <Pressable onPress={() => setPath(crumb.path)} disabled={crumb.path === path}>
                <Text
                  style={[styles.breadcrumbText, { color: crumb.path === path ? colors.text : '#3b82f6' }]}
                  numberOfLines={1}
                >
                  {crumb.label}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
        <Pressable style={styles.refreshButton} onPress={() => load(path)}>
          <Icon path={mdiRefresh} size={20} color={colors.text} />
        </Pressable>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {suggested.length > 0 && (
        <View style={styles.suggestedBox}>
          <Text style={[styles.suggestedHeading, { color: colors.subtleText }]}>Suggested folders</Text>
          <View style={styles.suggestedRow}>
            {suggested.map((entry) => (
              <Pressable key={entry.relativePath} style={styles.suggestedChip} onPress={() => setPath(entry.relativePath)}>
                <IconLabel path={mdiFolder} text={entry.name} color="#3b82f6" iconSize={15} textStyle={styles.suggestedChipText} />
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {entries === null ? (
        <ActivityIndicator style={styles.loading} color={colors.text} />
      ) : (
        <FlatList
          style={styles.list}
          data={entries}
          keyExtractor={(entry) => entry.relativePath}
          ListEmptyComponent={<Text style={[styles.empty, { color: colors.subtleText }]}>No subfolders here.</Text>}
          renderItem={({ item }) => {
            const covering = existingRoots?.length ? findCoveringRoot(joinPath(rootId, item.relativePath), existingRoots) : undefined;
            return (
              <Pressable style={styles.row} onPress={() => setPath(item.relativePath)} disabled={!!covering}>
                <IconLabel
                  path={mdiFolder}
                  text={item.name}
                  color={covering ? colors.subtleText : colors.text}
                  iconSize={18}
                  textStyle={styles.rowText}
                />
                {covering && (
                  <Text style={[styles.coveredNote, { color: colors.subtleText }]}>Already scanned by {covering.displayName}</Text>
                )}
              </Pressable>
            );
          }}
        />
      )}

      <View style={styles.actionsRow}>
        <Pressable style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.selectButton, currentPathCovered && styles.selectButtonDisabled]}
          onPress={() => onSelect(path)}
          disabled={!!currentPathCovered}
        >
          <Text style={styles.selectButtonText}>Select This Folder</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  upButton: {
    marginRight: 8,
    padding: 4,
  },
  refreshButton: {
    marginLeft: 8,
    padding: 4,
  },
  breadcrumbRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  breadcrumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  breadcrumbSeparator: {
    marginHorizontal: 4,
  },
  breadcrumbText: {
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#dc2626',
    marginTop: 12,
  },
  suggestedBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
  suggestedHeading: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  suggestedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  suggestedChip: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestedChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  loading: {
    marginTop: 24,
  },
  list: {
    flex: 1,
    marginTop: 12,
  },
  empty: {
    opacity: 0.6,
    marginTop: 12,
  },
  row: {
    paddingVertical: 10,
  },
  rowText: {
    fontSize: 15,
  },
  coveredNote: {
    fontSize: 12,
    marginTop: 2,
    marginLeft: 26,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.3)',
  },
  cancelButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelButtonText: {
    color: '#3b82f6',
    fontWeight: '600',
  },
  selectButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  selectButtonDisabled: {
    opacity: 0.4,
  },
  selectButtonText: {
    color: 'white',
    fontWeight: '600',
  },
});

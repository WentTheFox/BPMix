import type { DirectoryEntry, FileAccess } from '@bpmix/core';
import { mdiFolder } from '@mdi/js';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

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
export function FolderBrowser({ colors, fileAccess, rootId, rootDisplayName, initialPath, onSelect, onCancel }: FolderBrowserProps) {
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

  // rootDisplayName plus each non-empty path segment, each carrying the
  // relativePath a tap on it should jump back to.
  const segments = path ? path.split('/').filter(Boolean) : [];
  const crumbs = [
    { label: rootDisplayName, path: '' },
    ...segments.map((segment, index) => ({ label: segment, path: segments.slice(0, index + 1).join('/') })),
  ];

  return (
    <View style={styles.container}>
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

      {error && <Text style={styles.error}>{error}</Text>}

      {entries === null ? (
        <ActivityIndicator style={styles.loading} color={colors.text} />
      ) : (
        <FlatList
          style={styles.list}
          data={entries}
          keyExtractor={(entry) => entry.relativePath}
          ListEmptyComponent={<Text style={[styles.empty, { color: colors.subtleText }]}>No subfolders here.</Text>}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => setPath(item.relativePath)}>
              <IconLabel path={mdiFolder} text={item.name} color={colors.text} iconSize={18} textStyle={styles.rowText} />
            </Pressable>
          )}
        />
      )}

      <View style={styles.actionsRow}>
        <Pressable style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.selectButton} onPress={() => onSelect(path)}>
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
  breadcrumbRow: {
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
  selectButtonText: {
    color: 'white',
    fontWeight: '600',
  },
});

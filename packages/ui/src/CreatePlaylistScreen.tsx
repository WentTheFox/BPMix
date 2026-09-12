import {
  findPlaylistCandidateTracks,
  sortPlaylistCandidates,
  writePlaylistFile,
  type FileAccess,
  type PlaylistCandidateTrack,
  type PlaylistSortCriterion,
  type PlaylistSortOrder,
} from '@bpmix/core';
import { mdiCheck } from '@mdi/js';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BackButton } from './BackButton';
import { Icon } from './Icon';
import type { Colors } from './theme';
import { withAlpha } from './theme';

export interface CreatePlaylistScreenProps {
  colors: Colors;
  fileAccess: FileAccess;
  rootId: string;
  /** '' for the root itself. */
  folderRelativePath: string;
  /** Display label for the folder being turned into a playlist - e.g. the root's own display name for '', or the folder's own name otherwise. */
  folderDisplayName: string;
  onCancel: () => void;
  /** Called after the playlist file is successfully written, with its relativePath - the caller should rescan the root (to pick the new .m3u8 up through the normal scanRoot path) and close this screen. */
  onCreated: (relativePath: string) => void;
}

const SORT_OPTIONS: { value: PlaylistSortCriterion; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'dateCreated', label: 'Date' },
];

const ORDER_OPTIONS: { value: PlaylistSortOrder; label: string }[] = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
];

const PREVIEW_COUNT = 5;

function trackLabel(track: PlaylistCandidateTrack): string {
  const title = track.title ?? track.file.name;
  return track.artist ? `${title} • ${track.artist}` : title;
}

/**
 * Generates a new .m3u8 playlist from every audio file under a folder,
 * recursively - see CLAUDE.md's "let the user create a playlist directly
 * from a folder" TODO this exists for. Opened from LibraryScreen's
 * "New Playlist" action (via FolderBrowser to pick the folder), scoped to
 * an already-granted root. Reads every candidate file's tags up front
 * (findPlaylistCandidateTracks) so sort criterion/order can be switched
 * instantly afterward without re-reading anything - see
 * sortPlaylistCandidates's own doc.
 */
export function CreatePlaylistScreen({ colors, fileAccess, rootId, folderRelativePath, folderDisplayName, onCancel, onCreated }: CreatePlaylistScreenProps) {
  const [candidates, setCandidates] = useState<PlaylistCandidateTrack[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(() => folderDisplayName.split('/').pop() || 'New Playlist');
  const [sortBy, setSortBy] = useState<PlaylistSortCriterion>('title');
  const [order, setOrder] = useState<PlaylistSortOrder>('asc');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setLoadError(null);
    findPlaylistCandidateTracks(fileAccess, rootId, folderRelativePath)
      .then((found) => {
        if (!cancelled) setCandidates(found);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fileAccess, rootId, folderRelativePath]);

  const sortedTracks = useMemo(() => (candidates ? sortPlaylistCandidates(candidates, sortBy, order) : []), [candidates, sortBy, order]);

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const relativePath = await writePlaylistFile(fileAccess, rootId, folderRelativePath, name, sortedTracks);
      onCreated(relativePath);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <BackButton text="Create Playlist" color={colors.text} onPress={onCancel} disabled={creating} style={styles.backRow} />

      <Text style={[styles.fromLabel, { color: colors.subtleText }]} numberOfLines={1}>
        From: {folderDisplayName || 'this folder'}
      </Text>

      <TextInput
        style={[styles.nameInput, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }]}
        placeholder="Playlist name"
        placeholderTextColor={colors.subtleText}
        value={name}
        onChangeText={setName}
        editable={!creating}
      />

      <Text style={[styles.sectionTitle, { color: colors.subtleText }]}>SORT BY</Text>
      <View style={styles.choiceRow}>
        {SORT_OPTIONS.map((option) => {
          const selected = sortBy === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setSortBy(option.value)}
              disabled={creating}
              style={[styles.choice, { borderColor: selected ? colors.accent : withAlpha(colors.text, 0.25) }, selected && { backgroundColor: colors.accent }]}
            >
              <Text style={[styles.choiceText, { color: selected ? '#fff' : colors.text }]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.choiceRow}>
        {ORDER_OPTIONS.map((option) => {
          const selected = order === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setOrder(option.value)}
              disabled={creating}
              style={[styles.choice, { borderColor: selected ? colors.accent : withAlpha(colors.text, 0.25) }, selected && { backgroundColor: colors.accent }]}
            >
              <Text style={[styles.choiceText, { color: selected ? '#fff' : colors.text }]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {loadError && <Text style={styles.error}>{loadError}</Text>}

      {candidates === null && !loadError ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.subtleText }]}>Finding audio files…</Text>
        </View>
      ) : (
        <>
          <Text style={[styles.sectionTitle, { color: colors.subtleText }]}>
            {sortedTracks.length} TRACK{sortedTracks.length === 1 ? '' : 'S'} FOUND
          </Text>
          {sortedTracks.slice(0, PREVIEW_COUNT).map((track, i) => (
            <Text key={track.file.id} style={[styles.previewRow, { color: colors.text }]} numberOfLines={1}>
              {i + 1}. {trackLabel(track)}
            </Text>
          ))}
          {sortedTracks.length > PREVIEW_COUNT && (
            <Text style={[styles.previewMore, { color: colors.subtleText }]}>…and {sortedTracks.length - PREVIEW_COUNT} more</Text>
          )}

          {createError && <Text style={styles.error}>{createError}</Text>}

          <Pressable
            onPress={() => void handleCreate()}
            disabled={creating || sortedTracks.length === 0 || name.trim() === ''}
            style={[
              styles.createButton,
              { backgroundColor: colors.accent, opacity: creating || sortedTracks.length === 0 || name.trim() === '' ? 0.5 : 1 },
            ]}
          >
            {creating ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Icon path={mdiCheck} size={18} color="#fff" />
                <Text style={styles.createButtonText}>Create Playlist</Text>
              </>
            )}
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  backRow: {
    marginTop: 8,
  },
  fromLabel: {
    fontSize: 13,
  },
  nameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choice: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  choiceText: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  loadingText: {
    fontSize: 14,
  },
  previewRow: {
    fontSize: 14,
  },
  previewMore: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  error: {
    color: '#dc2626',
    fontSize: 13,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 8,
    paddingVertical: 12,
    marginTop: 8,
    marginBottom: 24,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});

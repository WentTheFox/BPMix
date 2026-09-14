import type { FileRef } from '@bpmix/core';
import { mdiMusicNote } from '@mdi/js';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BackButton } from './BackButton';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface LocateMissingFileScreenProps {
  colors: Colors;
  /** The missing track's expected filename - shown in the header for context, same value trackDisplayName(track) would give. */
  missingTrackName: string;
  /** Every audio-looking file in the track's root (see isAudioFileName) - null while still walking the root. */
  candidates: FileRef[] | null;
  /** True between tapping a candidate and the m3u8 rewrite actually landing - disables the list and shows a spinner instead of leaving it tappable again. */
  relocating: boolean;
  onSelect: (file: FileRef) => void;
  onCancel: () => void;
}

/**
 * Full-screen search-and-pick list of every audio file in a root, for
 * pointing a missing playlist entry (see TrackRecord.missing) at its real
 * current location instead of leaving it permanently greyed out. Mirrors
 * LyricsPickerScreen's exact shape (search-by-filename over a flat
 * candidate list) rather than a folder-by-folder browse - the file could be
 * anywhere in the root, and search-by-name is the fastest way to find it
 * again after a rename/move within an already-granted root.
 */
export function LocateMissingFileScreen({ colors, missingTrackName, candidates, relocating, onSelect, onCancel }: LocateMissingFileScreenProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!candidates) return [];
    const needle = query.trim().toLowerCase();
    return needle ? candidates.filter((c) => c.name.toLowerCase().includes(needle)) : candidates;
  }, [candidates, query]);

  return (
    <View style={styles.container}>
      <BackButton text="Locate File" color={colors.text} onPress={onCancel} disabled={relocating} fontSize={16} style={styles.backRow} />
      <Text style={[styles.subtitle, { color: colors.subtleText }]} numberOfLines={1}>
        Find the file that replaces "{missingTrackName}"
      </Text>

      <TextInput
        style={[styles.search, { color: colors.text, borderColor: colors.subtleText }]}
        placeholder="Search by filename…"
        placeholderTextColor={colors.subtleText}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        autoCapitalize="none"
        editable={!relocating}
      />

      {relocating || candidates === null ? (
        <View style={styles.centeredLoading}>
          <ActivityIndicator color={colors.subtleText} />
          <Text style={[styles.loadingText, { color: colors.subtleText }]}>{relocating ? 'Updating playlist…' : 'Scanning for audio files…'}</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={filtered}
          keyExtractor={(file) => file.id}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.subtleText }]}>
              {candidates.length === 0 ? 'No audio files found in this folder.' : 'No match for that search.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onSelect(item)}>
              <IconLabel path={mdiMusicNote} text={item.relativePath} color={colors.text} iconSize={16} textStyle={styles.rowText} numberOfLines={1} ellipsizeMode="middle" />
            </Pressable>
          )}
        />
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
    paddingVertical: 12,
  },
  backRow: {
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    marginBottom: 8,
  },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  list: {
    flex: 1,
    marginTop: 12,
  },
  centeredLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingText: {
    opacity: 0.6,
    textAlign: 'center',
  },
  empty: {
    opacity: 0.6,
    marginTop: 24,
    textAlign: 'center',
  },
  row: {
    paddingVertical: 10,
  },
  rowText: {
    fontSize: 15,
  },
});

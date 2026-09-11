import type { FileRef } from '@bpmix/core';
import { mdiSubtitles, mdiTrashCanOutline } from '@mdi/js';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BackButton } from './BackButton';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface LyricsPickerScreenProps {
  colors: Colors;
  /** Every .lrc file across every configured lyrics scope - see scanAllLyricsScopes. Null while still loading. */
  candidates: FileRef[] | null;
  /** fileId of whichever .lrc file is currently assigned, if any - highlighted in the list. */
  currentFileId: string | null;
  /** True between tapping a candidate/Remove and the storage write actually landing - disables the list and shows a spinner instead of leaving it tappable-again. */
  saving: boolean;
  onSelect: (fileId: string) => void;
  /** Removes the current track's assignment entirely, if it has one. */
  onClear: () => void;
  onCancel: () => void;
}

/**
 * Full-screen search-and-pick list of every .lrc file across the user's
 * configured lyrics scopes, for manually assigning (or overriding an
 * auto-match) one to the current track. Filters by filename substring since
 * a lyrics folder can hold names that don't stem-match a track at all
 * (compilations, differently-named rips, etc.) - the whole reason a manual
 * override needs to exist alongside findAutoLyricsMatch.
 */
export function LyricsPickerScreen({ colors, candidates, currentFileId, saving, onSelect, onClear, onCancel }: LyricsPickerScreenProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!candidates) return [];
    const needle = query.trim().toLowerCase();
    return needle ? candidates.filter((c) => c.name.toLowerCase().includes(needle)) : candidates;
  }, [candidates, query]);

  return (
    <View style={styles.container}>
      <BackButton text="Link Lyrics File" color={colors.text} onPress={onCancel} disabled={saving} fontSize={16} style={styles.backRow} />

      <TextInput
        style={[styles.search, { color: colors.text, borderColor: colors.subtleText }]}
        placeholder="Search by filename…"
        placeholderTextColor={colors.subtleText}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        autoCapitalize="none"
        editable={!saving}
      />

      {currentFileId && (
        <Pressable style={styles.clearRow} onPress={onClear} disabled={saving}>
          <IconLabel path={mdiTrashCanOutline} text="Remove lyrics from this track" color="#dc2626" iconSize={16} textStyle={styles.clearText} />
        </Pressable>
      )}

      {saving || candidates === null ? (
        <View style={styles.centeredLoading}>
          <ActivityIndicator color={colors.subtleText} />
          <Text style={[styles.loadingText, { color: colors.subtleText }]}>{saving ? 'Saving…' : 'Scanning lyrics folders…'}</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={filtered}
          keyExtractor={(file) => file.id}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.subtleText }]}>
              {candidates.length === 0 ? 'No .lrc files found in your configured lyrics folders.' : 'No match for that search.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onSelect(item.id)}>
              <IconLabel
                path={mdiSubtitles}
                text={item.name}
                color={item.id === currentFileId ? colors.accent : colors.text}
                iconSize={16}
                textStyle={[styles.rowText, item.id === currentFileId && styles.rowTextActive]}
                numberOfLines={1}
                ellipsizeMode="middle"
              />
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
    marginBottom: 8,
  },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  clearRow: {
    marginTop: 12,
  },
  clearText: {
    fontSize: 13,
    fontWeight: '600',
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
  rowTextActive: {
    fontWeight: '600',
  },
});

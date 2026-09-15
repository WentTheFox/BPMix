import { trackDisplayName, type LibraryStore, type TrackRecord } from '@bpmix/core';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, TextInput } from 'react-native';
import type { Colors } from './theme';
import { TRACK_ROW_HEIGHT, TrackRow } from './TrackRow';

export interface TrackListProps {
  trackFileIds: string[];
  tracksById: Map<string, TrackRecord>;
  currentFileId: string | null;
  isPlaying: boolean;
  /** See TrackRow.isLoading's doc - passed straight through. */
  isLoading?: boolean;
  textColor: string;
  /** Only needed for the search box's border/placeholder - see the note above the TextInput below. */
  colors: Colors;
  onPressTrack: (track: TrackRecord) => void;
  libraryStore: LibraryStore;
  /** How many rows to render up front - tunable per app since mobile/web have historically used different values here, not because the list itself differs. */
  initialNumToRender?: number;
  /** fileIds whose most recent playback attempt failed to decode - see TrackRow.isMissing's doc. Omitted entirely (not just empty) by a caller that doesn't track this. */
  missingFileIds?: Set<string>;
}

/**
 * The playlist screen's track list - a virtualized FlatList of TrackRow,
 * with getItemLayout wired to TrackRow's fixed height (TRACK_ROW_HEIGHT)
 * so a long list can compute any row's scroll position by arithmetic
 * instead of measuring as it goes (the playlist's length - and so every
 * row's position - is known upfront). Shared between mobile and web
 * (identical there beyond initialNumToRender, so it lives here rather than
 * being duplicated per-app - see CLAUDE.md's note on why that's worth
 * doing proactively).
 *
 * Includes its own filename search box above the list - filters by
 * trackDisplayName (the filename) rather than scanned title/artist
 * metadata, since that's the one thing synchronously available for every
 * row here without waiting on the background metadata scan (see
 * scanLibraryMetadata) or fetching it in bulk just for search. Good enough
 * to find a track in a large playlist by name; doesn't match on artist
 * unless the filename happens to include it.
 */
export function TrackList({
  trackFileIds,
  tracksById,
  currentFileId,
  isPlaying,
  isLoading,
  textColor,
  colors,
  onPressTrack,
  libraryStore,
  initialNumToRender = 20,
  missingFileIds,
}: TrackListProps): React.JSX.Element {
  const [query, setQuery] = useState('');

  const filteredFileIds = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return trackFileIds;
    return trackFileIds.filter((fileId) => {
      const track = tracksById.get(fileId);
      return !!track && trackDisplayName(track).toLowerCase().includes(needle);
    });
  }, [trackFileIds, tracksById, query]);

  // TrackRow is wrapped in memo() specifically so a long list's off-screen/
  // unchanged rows don't re-render on every ~200ms playback poll tick (see
  // its own doc) - an inline renderItem here would defeat that entirely,
  // since FlatList treats a changed renderItem identity as a reason to
  // re-render every currently-mounted row, not just this list's own JSX.
  const renderItem = useCallback(
    ({ item: fileId }: { item: string }) => {
      const track = tracksById.get(fileId);
      if (!track) return null;
      return (
        <TrackRow
          track={track}
          isCurrent={currentFileId === fileId}
          isPlaying={isPlaying}
          isLoading={isLoading}
          textColor={textColor}
          colors={colors}
          onPress={onPressTrack}
          libraryStore={libraryStore}
          isMissing={track.missing || missingFileIds?.has(fileId)}
        />
      );
    },
    [tracksById, currentFileId, isPlaying, isLoading, textColor, colors, onPressTrack, libraryStore, missingFileIds],
  );

  return (
    <>
      <TextInput
        style={[styles.search, { color: textColor, borderColor: colors.subtleText }]}
        placeholder="Search tracks…"
        placeholderTextColor={colors.subtleText}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        autoCapitalize="none"
      />
      <FlatList
        style={styles.list}
        data={filteredFileIds}
        keyExtractor={(fileId, index) => `${fileId}-${index}`}
        renderItem={renderItem}
        initialNumToRender={initialNumToRender}
        windowSize={7}
        // FlatList only re-renders already-mounted rows when `data` or
        // `extraData` changes - currentFileId/isPlaying are closed over
        // inside renderItem instead, so without this, a row already on
        // screen wouldn't pick up "now playing"/highlight changes until
        // something else happened to force FlatList to re-render (e.g.
        // scrolling), which read as the highlight lagging a tap by however
        // long that took to happen on its own.
        extraData={[currentFileId, isPlaying, isLoading, missingFileIds]}
        // Only valid while filteredFileIds is the unfiltered list - a
        // filtered list's rows keep TRACK_ROW_HEIGHT each, but their offsets
        // no longer correspond to `index * TRACK_ROW_HEIGHT` against the
        // full playlist, so this only needs to (and does) hold since it's
        // computed straight from filteredFileIds' own index each time.
        getItemLayout={(_, index) => ({ length: TRACK_ROW_HEIGHT, offset: TRACK_ROW_HEIGHT * index, index })}
      />
    </>
  );
}

const styles = StyleSheet.create({
  search: {
    marginTop: 16,
    // Matches HeaderRow's own horizontal inset (16) and TrackRow's - without
    // this, the search box's border sat flush against the screen edges even
    // though its placeholder text had its own inset padding, reading as
    // inconsistent with every other edge-aligned element on the screen.
    marginHorizontal: 16,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  list: {
    flex: 1,
    marginTop: 12,
    width: '100%',
    maxWidth: 480,
  },
});

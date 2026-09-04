import type { LibraryStore, TrackRecord } from '@bpmix/core';
import { FlatList, StyleSheet } from 'react-native';
import { TRACK_ROW_HEIGHT, TrackRow } from './TrackRow';

export interface TrackListProps {
  trackFileIds: string[];
  tracksById: Map<string, TrackRecord>;
  currentFileId: string | null;
  isPlaying: boolean;
  textColor: string;
  onPressTrack: (track: TrackRecord) => void;
  libraryStore: LibraryStore;
  /** How many rows to render up front - tunable per app since mobile/web have historically used different values here, not because the list itself differs. */
  initialNumToRender?: number;
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
 */
export function TrackList({
  trackFileIds,
  tracksById,
  currentFileId,
  isPlaying,
  textColor,
  onPressTrack,
  libraryStore,
  initialNumToRender = 20,
}: TrackListProps): React.JSX.Element {
  return (
    <FlatList
      style={styles.list}
      data={trackFileIds}
      keyExtractor={(fileId, index) => `${fileId}-${index}`}
      renderItem={({ item: fileId }) => {
        const track = tracksById.get(fileId);
        if (!track) return null;
        return (
          <TrackRow
            track={track}
            isCurrent={currentFileId === fileId}
            isPlaying={isPlaying}
            textColor={textColor}
            onPress={onPressTrack}
            libraryStore={libraryStore}
          />
        );
      }}
      initialNumToRender={initialNumToRender}
      windowSize={7}
      // FlatList only re-renders already-mounted rows when `data` or
      // `extraData` changes - currentFileId/isPlaying are closed over
      // inside renderItem instead, so without this, a row already on
      // screen wouldn't pick up "now playing"/highlight changes until
      // something else happened to force FlatList to re-render (e.g.
      // scrolling), which read as the highlight lagging a tap by however
      // long that took to happen on its own.
      extraData={[currentFileId, isPlaying]}
      getItemLayout={(_, index) => ({ length: TRACK_ROW_HEIGHT, offset: TRACK_ROW_HEIGHT * index, index })}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
    marginTop: 24,
    width: '100%',
    maxWidth: 480,
  },
});

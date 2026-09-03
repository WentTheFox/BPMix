import { formatTrackTitle, type LibraryStore, type TrackRecord } from '@bpmix/core';
import { mdiPlay } from '@mdi/js';
import { memo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { useCoverArt } from './useCoverArt';
import { useTrackMetadata } from './useTrackMetadata';

export interface TrackRowProps {
  track: TrackRecord;
  isCurrent: boolean;
  isPlaying: boolean;
  /** Text color for a non-current row - a current row always uses the accent color instead, regardless of this. */
  textColor: string;
  onPress: (track: TrackRecord) => void;
  libraryStore: LibraryStore;
}

const ART_SIZE = 28;

/** One row in a playlist's track list - a small play glyph when it's the current, actively-playing track, its cover art thumbnail (once scanned/if it has any), and the track's title/artist (or its filename until metadata is scanned/if it has none). Shared between mobile and web (identical on both, so it lives here rather than being duplicated per-app). */
export const TrackRow = memo(function TrackRow({ track, isCurrent, isPlaying, textColor, onPress, libraryStore }: TrackRowProps) {
  const metadata = useTrackMetadata(libraryStore, track.fileId);
  const coverArt = useCoverArt(libraryStore, track.fileId, metadata !== null);
  return (
    <Pressable style={styles.trackRow} onPress={() => onPress(track)}>
      <View style={styles.trackRowContent}>
        {coverArt ? (
          <Image source={{ uri: coverArt }} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artPlaceholder]} />
        )}
        {isCurrent && isPlaying && <Icon path={mdiPlay} size={14} color="#3b82f6" />}
        <Text style={[styles.trackName, { color: isCurrent ? '#3b82f6' : textColor }]} numberOfLines={1}>
          {formatTrackTitle(metadata, track)}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  trackRow: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  trackRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  art: {
    width: ART_SIZE,
    height: ART_SIZE,
    borderRadius: 3,
  },
  artPlaceholder: {
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  trackName: {
    fontSize: 14,
    flexShrink: 1,
  },
});

import { trackDisplayName, type TrackRecord } from '@bpmix/core';
import { mdiPlay } from '@mdi/js';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';

export interface TrackRowProps {
  track: TrackRecord;
  isCurrent: boolean;
  isPlaying: boolean;
  /** Text color for a non-current row - a current row always uses the accent color instead, regardless of this. */
  textColor: string;
  onPress: (track: TrackRecord) => void;
}

/** One row in a playlist's track list - a small play glyph when it's the current, actively-playing track, otherwise just the name. Shared between mobile and web (identical on both, so it lives here rather than being duplicated per-app). */
export const TrackRow = memo(function TrackRow({ track, isCurrent, isPlaying, textColor, onPress }: TrackRowProps) {
  return (
    <Pressable style={styles.trackRow} onPress={() => onPress(track)}>
      <View style={styles.trackRowContent}>
        {isCurrent && isPlaying && <Icon path={mdiPlay} size={14} color="#3b82f6" />}
        <Text style={[styles.trackName, { color: isCurrent ? '#3b82f6' : textColor }]} numberOfLines={1}>
          {trackDisplayName(track)}
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
  trackName: {
    fontSize: 14,
    flexShrink: 1,
  },
});

import { isPlayingNow } from '@bpmix/core';
import { mdiPlay } from '@mdi/js';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatAgo } from '../formatAgo';
import { IconLabel } from '../IconLabel';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import type { ContinueItem } from './useContinueElsewhere';

export interface ContinueElsewhereProps {
  colors: Colors;
  items: ContinueItem[];
  error: string | null;
  onContinue: (item: ContinueItem) => void;
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** "Continue on Pixel 8" (or "Playing now on" while it is): what the person's other devices play, one tap to pick it up here. Renders nothing when there's none. */
export function ContinueElsewhere({ colors, items, error, onContinue }: ContinueElsewhereProps) {
  if (items.length === 0) return null;
  const now = Date.now();
  return (
    <View style={styles.container}>
      {items.slice(0, 3).map((item) => {
        const live = isPlayingNow(item.remote, now);
        const position = `${fmt(item.remote.positionSeconds)} in`;
        return (
          <Pressable
            key={item.remote.deviceId}
            onPress={() => onContinue(item)}
            style={[styles.card, { borderColor: withAlpha(colors.text, 0.2), backgroundColor: withAlpha(colors.accent, 0.1) }]}
          >
            <IconLabel path={mdiPlay} text={`${live ? 'Playing now on' : 'Continue on'} ${item.remote.deviceName}`} color={colors.accent} iconSize={18} textStyle={styles.heading} />
            <Text numberOfLines={1} style={[styles.detail, { color: colors.text }]}>
              {item.title}
            </Text>
            <Text style={[styles.meta, { color: colors.subtleText }]}>{live ? `${position} · tap to play it here` : `${position} · ${formatAgo(item.remote.updatedAtMs, now)}`}</Text>
          </Pressable>
        );
      })}
      {error && <Text style={[styles.error, { color: '#dc2626' }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  card: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
  heading: { fontSize: 14, fontWeight: '700' },
  detail: { fontSize: 15, marginTop: 2 },
  meta: { fontSize: 12 },
  error: { fontSize: 13 },
});

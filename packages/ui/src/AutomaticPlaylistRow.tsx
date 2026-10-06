import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface AutomaticPlaylistRowProps {
  colors: Colors;
  icon: string;
  label: string;
  /** Synchronous ("Now Playing", built from data already in memory) or async (`onShowUnplaylisted`'s real directory walk) - either way, the row shows a busy label while it's in flight rather than looking unresponsive. */
  onPress: () => void | Promise<void>;
  /** Accent-colors this row, same treatment as a real playlist row's own now-playing highlight - used by LibraryScreen's "Now Playing" row once shuffle is on, when it (not the real playlist whose order no longer matches) is the one actually governing playback order. */
  highlighted?: boolean;
}

/**
 * A row in LibraryScreen's per-root "Automatic" section - a
 * library-store-computed playlist that's never written as a real
 * PlaylistRecord (see findUnplaylistedTracks' own doc for why), styled
 * like an ordinary playlist row but under its own heading so it doesn't
 * read as something the user curated themselves.
 */
export function AutomaticPlaylistRow({ colors, icon, label, onPress, highlighted }: AutomaticPlaylistRowProps) {
  const [loading, setLoading] = useState(false);

  const handlePress = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await onPress();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Pressable style={styles.row} onPress={() => void handlePress()} disabled={loading}>
      <IconLabel path={icon} text={loading ? 'Finding…' : label} color={highlighted ? colors.accent : colors.text} iconSize={16} textStyle={styles.label} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    marginTop: 8,
    paddingLeft: 8,
  },
  label: {
    fontSize: 15,
  },
});

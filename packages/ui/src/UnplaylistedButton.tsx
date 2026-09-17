import { mdiMusicNote } from '@mdi/js';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface UnplaylistedButtonProps {
  colors: Colors;
  /** Walks the root for every audio file no current playlist references (see findUnplaylistedTracks) and opens the result - awaited so this button can show a busy state for what's a real directory walk, not an instant local lookup. */
  onPress: () => Promise<void>;
}

/**
 * LibraryScreen's per-root "Songs not in a playlist" action - see
 * CLAUDE.md's UI/UX TODO this implements. Reuses mdiMusicNote (already
 * Windows-mapped - see Icon.windows.tsx's CODEPOINTS) rather than
 * introducing a new icon that would need its own hand-verified codepoint.
 */
export function UnplaylistedButton({ colors, onPress }: UnplaylistedButtonProps) {
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
    <Pressable onPress={() => void handlePress()} disabled={loading} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
      {loading ? <Text style={{ color: colors.accent }}>Finding…</Text> : <IconLabel path={mdiMusicNote} text="Unplaylisted" color={colors.accent} iconSize={16} />}
    </Pressable>
  );
}

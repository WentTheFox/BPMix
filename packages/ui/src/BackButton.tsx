import { mdiArrowLeft } from '@mdi/js';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { IconLabel } from './IconLabel';

export interface BackButtonProps {
  text: string;
  color: string;
  onPress: () => void;
  /** Matches each screen's existing title size (Now Playing/Settings/playlist use 18, Lyrics Picker uses 16). */
  fontSize?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The back-arrow-plus-label control used as the left side of a screen's header
 * (Now Playing, Settings, playlist, Lyrics Picker). Was duplicated identically
 * across those screens with no hitSlop, making the small label text the only
 * reliable tap target - generous hitSlop here fixes that everywhere at once.
 */
export function BackButton({ text, color, onPress, fontSize = 18, disabled, style }: BackButtonProps) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={style} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}>
      <IconLabel path={mdiArrowLeft} text={text} color={color} iconSize={18} textStyle={[styles.text, { fontSize }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  text: {
    fontWeight: '600',
  },
});

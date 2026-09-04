import { mdiMusicNote } from '@mdi/js';
import { StyleSheet } from 'react-native';
import { IconLabel } from './IconLabel';

export interface AppTitleProps {
  color: string;
}

/**
 * The "BPMix" title/note-icon header - identical in both apps' library and
 * restoring screens (four call sites total before this was extracted).
 */
export function AppTitle({ color }: AppTitleProps) {
  return (
    <IconLabel path={mdiMusicNote} text="BPMix" color={color} iconSize={28} textStyle={styles.title} containerStyle={styles.titleRow} />
  );
}

const styles = StyleSheet.create({
  titleRow: {
    marginBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
  },
});

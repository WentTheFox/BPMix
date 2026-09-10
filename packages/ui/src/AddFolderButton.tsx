import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface AddFolderButtonProps {
  colors: Colors;
  icon: string;
  text: string;
  onPress: () => void;
  busy?: boolean;
  busyText?: string;
}

/**
 * The "Add Folder" / "Add Lyrics Folder" button shape - identical Pressable
 * + icon/text + optional busy spinner used by both, so LibraryScreen can
 * lay them out side by side (see its buttonRow) without duplicating this
 * markup per button.
 */
export function AddFolderButton({ colors, icon, text, onPress, busy = false, busyText }: AddFolderButtonProps) {
  return (
    <Pressable
      style={[styles.button, { backgroundColor: colors.accent }, busy && styles.buttonDisabled]}
      onPress={onPress}
      disabled={busy}
    >
      {busy ? (
        <View style={styles.buttonRow}>
          <ActivityIndicator color="#fff" style={styles.buttonSpinner} />
          <Text style={styles.buttonText}>{busyText ?? 'Working…'}</Text>
        </View>
      ) : (
        <IconLabel path={icon} text={text} color="white" iconSize={18} textStyle={styles.buttonText} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  buttonSpinner: {
    marginRight: 8,
  },
  buttonText: {
    color: 'white',
    fontWeight: '600',
  },
});

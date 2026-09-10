import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

export interface AddFolderButtonProps {
  colors: Colors;
  icon: string;
  text: string;
  onPress: () => void;
  /** Swaps the label for a spinner + busyText - use only once there's real progress to show (e.g. scanning a newly-picked root), not while a native folder-picker prompt is merely open (see `disabled`'s doc for why). */
  busy?: boolean;
  busyText?: string;
  /**
   * Disables the button without switching to the busy spinner/text - e.g.
   * while a native folder-picker prompt is open and there's nothing yet to
   * show progress for (the OS picker is already its own full-screen modal).
   * Defaults to `busy` so existing callers passing only `busy` keep
   * disabling. Was briefly conflated with `busy` for this exact case and
   * that combination went blank on Windows - render committing a real
   * ActivityIndicator+Text frame while the native FolderPicker had focus,
   * then apparently never getting a repaint once the dialog closed and
   * `busy` flipped back to false, leaving a stale, content-less button
   * until the next unrelated re-render. Keeping the ordinary icon+text
   * visible (just non-interactive) instead sidesteps that RNW glitch
   * entirely, and is the more honest state anyway - nothing is "busy" yet
   * at that point, the user just can't double-invoke the prompt.
   */
  disabled?: boolean;
}

/**
 * The "Add Folder" / "Add Lyrics Folder" button shape - identical Pressable
 * + icon/text + optional busy spinner used by both, so LibraryScreen can
 * lay them out side by side (see its buttonRow) without duplicating this
 * markup per button.
 */
export function AddFolderButton({ colors, icon, text, onPress, busy = false, busyText, disabled }: AddFolderButtonProps) {
  const isDisabled = disabled ?? busy;
  return (
    <Pressable
      style={[styles.button, { backgroundColor: colors.accent }, isDisabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={isDisabled}
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

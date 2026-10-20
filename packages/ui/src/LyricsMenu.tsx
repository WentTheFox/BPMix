import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';

export interface LyricsMenuProps {
  colors: Colors;
  onOpenEditor: () => void;
  onChangeFile: () => void;
  onCancel: () => void;
}

/**
 * The popover opened by the header's lyrics icon (see HeaderActions) -
 * collapses what used to be three separate inline links on the Now
 * Playing lyrics panel (Sync lyrics manually / Edit timestamps / Change
 * lyrics file) into two actions: the combined LyricsEditorScreen (its own
 * Edit/Sync switch replaces the old sync-vs-edit-timestamps split), and
 * picking a different lyrics file. Same backdrop+centered-box shell as
 * ConfirmDialog, with a row of actions instead of confirm/cancel.
 */
export function LyricsMenu({ colors, onOpenEditor, onChangeFile, onCancel }: LyricsMenuProps) {
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={[styles.box, { backgroundColor: colors.background, borderColor: colors.accent }]}>
          <Pressable style={styles.row} onPress={onOpenEditor}>
            <Text style={[styles.rowText, { color: colors.text }]}>Lyrics editor</Text>
          </Pressable>
          <Pressable style={styles.row} onPress={onChangeFile}>
            <Text style={[styles.rowText, { color: colors.text }]}>Change lyrics file...</Text>
          </Pressable>
          <Pressable style={[styles.row, styles.cancelRow]} onPress={onCancel}>
            <Text style={[styles.rowText, { color: colors.subtleText }]}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Same oversized-rect-not-absoluteFill trick as ConfirmDialog/VolumeButton
  // - see either's doc for why.
  backdrop: {
    position: 'absolute',
    top: -2000,
    bottom: -2000,
    left: -2000,
    right: -2000,
  },
  centerWrap: {
    position: 'absolute',
    top: -2000,
    bottom: -2000,
    left: -2000,
    right: -2000,
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: {
    width: 260,
    maxWidth: '90%',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  row: {
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  cancelRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.25)',
    marginTop: 2,
  },
  rowText: {
    fontSize: 15,
    fontWeight: '600',
  },
});

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';

export interface ConfirmDialogProps {
  colors: Colors;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A full-screen backdrop plus a centered box explaining an action before it
 * runs, with Cancel/Confirm buttons - not React Native's own Modal (see
 * VolumeButton's identical reasoning: this codebase has no existing Modal
 * usage to follow, and react-native-windows's platform support tends to lag,
 * so a plain absolutely-positioned overlay avoids finding out about any
 * Modal quirks there the hard way).
 *
 * Unlike RemoveButton's inline "flip to Yes/No in place" confirmation, this
 * is for an action that needs an actual explanation shown first (e.g. what
 * "New Playlist" on a library root's header actually does), not just a
 * "are you sure" - so it renders as a real centered dialog over the whole
 * screen rather than a two-word swap next to the button that triggered it.
 */
export function ConfirmDialog({ colors, title, message, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={[styles.box, { backgroundColor: colors.background, borderColor: colors.accent }]}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.message, { color: colors.subtleText }]}>{message}</Text>
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.actionButton}>
              <Text style={[styles.actionText, { color: colors.subtleText }]}>{cancelLabel}</Text>
            </Pressable>
            <Pressable onPress={onConfirm} style={styles.actionButton}>
              <Text style={[styles.actionText, styles.confirmText, { color: colors.accent }]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // A big fixed-position rect rather than StyleSheet.absoluteFill - see
  // VolumeButton's identical backdrop for why (its wrapping View only auto-
  // sizes to the button, not the full screen).
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
    width: 280,
    maxWidth: '90%',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
    marginTop: 18,
  },
  actionButton: {
    paddingVertical: 4,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  confirmText: {
    fontWeight: '700',
  },
});

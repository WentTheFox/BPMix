import { mdiTrashCanOutline } from '@mdi/js';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { IconLabel } from './IconLabel';

export interface RemoveButtonProps {
  onConfirm: () => void;
}

/**
 * A "Remove" action that requires a second tap to actually fire - flips
 * in place to "Remove? Yes/No" instead of removing immediately, and back
 * to the plain button if you tap anywhere other than "Yes". Confirmation
 * state lives here (not in the caller) since each list row renders its own
 * instance, so per-row confirmation state falls out of that for free.
 *
 * Deliberately not a native Alert - react-native-windows's Alert support
 * has historically lagged the other platforms, and this needs to behave
 * identically on mobile, web, and Windows.
 */
export function RemoveButton({ onConfirm }: RemoveButtonProps) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <View style={styles.row}>
        <Text style={styles.prompt}>Remove?</Text>
        <Pressable onPress={onConfirm}>
          <Text style={styles.yes}>Yes</Text>
        </Pressable>
        <Pressable onPress={() => setConfirming(false)}>
          <Text style={styles.no}>No</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable onPress={() => setConfirming(true)}>
      <IconLabel path={mdiTrashCanOutline} text="Remove" color="#dc2626" iconSize={14} textStyle={styles.removeText} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  prompt: {
    fontSize: 12,
    color: '#dc2626',
  },
  yes: {
    fontSize: 12,
    fontWeight: '700',
    color: '#dc2626',
  },
  no: {
    fontSize: 12,
    color: '#3b82f6',
  },
  removeText: {
    fontSize: 12,
    color: '#dc2626',
  },
});

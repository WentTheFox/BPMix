import { mdiCog } from '@mdi/js';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { NotificationBell } from './notifications/NotificationBell';
import type { NotificationCenter } from './notifications/useNotificationCenter';
import type { Colors } from './theme';

export interface HeaderActionsProps {
  colors: Colors;
  center: NotificationCenter;
  onOpenSettings: () => void;
}

/**
 * Settings gear + NotificationBell together, for a HeaderRow's right slot.
 * The gap between them is well past what either button's own 14px hitSlop
 * needs to stay clear of the other's - a tap meant for the gear landing on
 * the bell (or vice versa) would pop open the wrong thing, and the bell in
 * particular opening by accident means dismissing an error/progress row the
 * user never meant to touch.
 */
export function HeaderActions({ colors, center, onOpenSettings }: HeaderActionsProps) {
  return (
    <View style={styles.row}>
      <Pressable onPress={onOpenSettings} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }} style={styles.settingsButton}>
        <Icon path={mdiCog} size={22} color={colors.text} />
      </Pressable>
      <NotificationBell colors={colors} center={center} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // 32px, not HeaderRow's own 12px row gap - both buttons carry a 14px
    // hitSlop on their facing edges, so anything under ~28px here would let
    // those two slop regions overlap and take a tap meant for one button as
    // the other.
    gap: 32,
  },
  settingsButton: {
    padding: 2,
  },
});

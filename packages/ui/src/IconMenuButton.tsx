import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import type { Colors } from './theme';
import { withAlpha } from './theme';

export interface IconMenuButtonProps {
  colors: Colors;
  icon: string;
  iconSize?: number;
  accessibilityLabel?: string;
  /** Rendered over the icon's bottom-left corner, e.g. an unread-count bubble - omitted entirely when there's nothing to badge, same as NotificationBell's own count badge did before this extraction. */
  badge?: ReactNode;
  /** Width of the dropdown panel - NotificationBell's own 320 by default. */
  panelWidth?: number;
  /** Render prop (not plain children) so panel content can close the menu itself - e.g. after picking an item - without the open/close state needing to live outside this component. */
  children: (close: () => void) => ReactNode;
}

/**
 * Icon button + dropdown panel anchored beneath it, inline in a HeaderRow's
 * right slot - not a self-positioned full-screen overlay. Extracted from
 * NotificationBell, which had this exact shape (bell icon + count badge +
 * anchored panel) before this split; NotificationBell and the lyrics-editor
 * menu (see HeaderActions) now both build on this instead of each owning
 * their own copy.
 *
 * Anchoring inline like this (position:'relative' container, the panel
 * itself position:'absolute' with top:'100%') matters beyond just avoiding
 * duplication: a full-screen backdrop+centered-box overlay (the shape the
 * lyrics menu used before this extraction) needs its own explicit top-level
 * zIndex to beat a nested descendant's zIndex-less content elsewhere in the
 * tree on this RN/Fabric version (see ScreenLayer's own doc for the root
 * cause) - confirmed live as the lyrics menu rendering "completely
 * inaccessible" underneath the playlist screen's own header. A panel
 * anchored to its own trigger button, inside the same HeaderRow the trigger
 * already lives in, never has to win that fight in the first place.
 */
export function IconMenuButton({ colors, icon, iconSize = 22, accessibilityLabel, badge, panelWidth = 320, children }: IconMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <View style={styles.container}>
      <Pressable style={styles.button} onPress={() => setOpen((o) => !o)} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }} accessibilityLabel={accessibilityLabel}>
        <Icon path={icon} size={iconSize} color={colors.text} />
        {badge}
      </Pressable>
      {open && <View style={[styles.panel, { width: panelWidth, backgroundColor: colors.background, borderColor: withAlpha(colors.text, 0.15) }]}>{children(close)}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    zIndex: 20,
  },
  button: {
    padding: 2,
  },
  panel: {
    position: 'absolute',
    // Just needs to clear the rest of its own HeaderRow (the icon row it's
    // anchored to) - see this component's own doc for why that's the whole
    // job, not fending off unrelated screen content below the header.
    zIndex: 20,
    top: '100%',
    right: 0,
    marginTop: 8,
    maxHeight: 420,
    // Without this, maxHeight isn't a real clip boundary on a plain View
    // (default overflow is 'visible') - content that grows past it (e.g. an
    // expanded notification detail) could push straight through instead of
    // scrolling within it.
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: 1,
    padding: 8,
  },
});

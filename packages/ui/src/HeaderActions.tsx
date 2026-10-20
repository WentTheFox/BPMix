import { mdiCog, mdiSubtitles } from '@mdi/js';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { IconMenuButton } from './IconMenuButton';
import { NotificationBell } from './notifications/NotificationBell';
import type { NotificationCenter } from './notifications/useNotificationCenter';
import type { Colors } from './theme';

export interface HeaderActionsProps {
  colors: Colors;
  center: NotificationCenter;
  onOpenSettings: () => void;
  /**
   * Same mdiSubtitles glyph TrackRow uses to flag a track that has lyrics
   * (see useHasLyrics) - a dropdown with the two lyrics-editor actions for
   * the currently playing track, via the shared IconMenuButton (same
   * anchored-panel pattern as NotificationBell, not a full-screen popover -
   * see IconMenuButton's own doc for why that matters). Omitted (button not
   * rendered at all) when the caller has nothing playing or the playing
   * track has no lyrics assigned, rather than rendered disabled - this
   * button is reused across every screen's header (see each App.tsx's
   * hoisted headerActionsEl), not just Now Playing, so most of the time
   * there's no current-track context to act on at all.
   */
  lyricsMenu?: {
    onOpenEditor: () => void;
    onChangeFile: () => void;
  };
}

/**
 * Lyrics menu (optional) + Settings gear + NotificationBell together, for a
 * HeaderRow's right slot. The gap between them is well past what either
 * button's own 14px hitSlop needs to stay clear of its neighbors - a tap
 * meant for one landing on another would pop open the wrong thing, and the
 * bell in particular opening by accident means dismissing an error/progress
 * row the user never meant to touch.
 */
export function HeaderActions({ colors, center, onOpenSettings, lyricsMenu }: HeaderActionsProps) {
  return (
    <View style={styles.row}>
      {lyricsMenu && (
        <IconMenuButton colors={colors} icon={mdiSubtitles} panelWidth={220} accessibilityLabel="Lyrics">
          {(close) => (
            <>
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  close();
                  lyricsMenu.onOpenEditor();
                }}
              >
                <Text style={[styles.menuItemText, { color: colors.text }]}>Lyrics editor</Text>
              </Pressable>
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  close();
                  lyricsMenu.onChangeFile();
                }}
              >
                <Text style={[styles.menuItemText, { color: colors.text }]}>Change lyrics file...</Text>
              </Pressable>
            </>
          )}
        </IconMenuButton>
      )}
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
  menuItem: {
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

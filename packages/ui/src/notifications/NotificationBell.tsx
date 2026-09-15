import { mdiAlertCircle, mdiBellOutline, mdiChevronDown, mdiChevronUp, mdiClose, mdiProgressClock } from '@mdi/js';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../Icon';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import type { AppNotification } from './types';
import type { NotificationCenter } from './useNotificationCenter';

export interface NotificationBellProps {
  colors: Colors;
  center: NotificationCenter;
}

/** Rounds down to whole minutes/hours/days - this is a passive status list, not a live-ticking clock, so a coarse "how long ago" reads fine without a re-render timer. */
function relativeTime(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function NotificationRow({
  notification,
  colors,
  expanded,
  onToggleExpand,
  onDismiss,
}: {
  notification: AppNotification;
  colors: Colors;
  expanded: boolean;
  onToggleExpand: () => void;
  onDismiss: () => void;
}) {
  const isProgress = notification.kind === 'progress';
  const progress = notification.progress;
  const fraction = progress && progress.total > 0 ? progress.current / progress.total : 0;

  return (
    <View style={[styles.row, { borderColor: withAlpha(colors.text, 0.1) }]}>
      <Pressable style={styles.rowHeader} onPress={notification.detail ? onToggleExpand : undefined}>
        <Icon
          path={isProgress ? mdiProgressClock : mdiAlertCircle}
          size={18}
          color={isProgress ? colors.accent : '#dc2626'}
        />
        <View style={styles.rowTextColumn}>
          <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={expanded ? undefined : 2}>
            {notification.title}
          </Text>
          <Text style={[styles.rowTime, { color: colors.subtleText }]}>
            {isProgress && progress ? `${progress.current}/${progress.total}${progress.done ? ' - done' : ''} - ` : ''}
            {relativeTime(notification.createdAt)}
          </Text>
          {isProgress && progress && !progress.done && (
            <View style={[styles.progressTrack, { backgroundColor: withAlpha(colors.accent, 0.18) }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.accent, width: `${Math.round(fraction * 100)}%` }]} />
            </View>
          )}
          {notification.action && (
            <Pressable
              onPress={(e) => {
                // See dismissButton's own stopPropagation comment - same reasoning.
                e.stopPropagation();
                notification.action!.onPress();
              }}
              style={styles.actionButton}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.actionText, { color: colors.accent }]}>{notification.action.label}</Text>
            </Pressable>
          )}
        </View>
        {notification.detail && <Icon path={expanded ? mdiChevronUp : mdiChevronDown} size={16} color={colors.subtleText} />}
        {/* stopPropagation matters on web (react-native-web Pressables are real DOM elements whose click events bubble) - without it, tapping dismiss also fires the outer row's onPress (expand toggle) it's nested inside. */}
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          style={styles.dismissButton}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Icon path={mdiClose} size={16} color={colors.subtleText} />
        </Pressable>
      </Pressable>
      {expanded && notification.detail && (
        <Text style={[styles.detailText, { color: colors.subtleText }]} selectable>
          {notification.detail}
        </Text>
      )}
    </View>
  );
}

/**
 * Plain bell icon (no button chrome/background) + dropdown panel anchored
 * beneath it - meant to sit inline in a HeaderRow's right slot on every
 * screen (library title row, playlist/now-playing back rows), not float as
 * a self-positioned overlay - a fixed-position bell used to sit on top of
 * whatever content happened to be underneath it regardless of which screen
 * was showing. This is the single persistent place errors and
 * background-operation status land, instead of a one-shot inline banner
 * whose text was often a raw, uncontextualized browser/native error string
 * (e.g. "A requested file or directory could not be found at the time an
 * operation was processed") that vanished the moment something else called
 * setError again. Notifications stay in the list (newest first) until
 * dismissed - both apps should route their PlaylistPlayer/usePlaybackPersistence
 * onError callbacks and any long-running scan's onProgress callback through
 * the same NotificationCenter (see useNotificationCenter) rather than a
 * plain error string, so this can't drift into a second, differently-shaped
 * error surface per platform.
 */
export function NotificationBell({ colors, center }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const count = center.notifications.length;
  // Red only for something the user actually needs to look at - a plain
  // background scan finishing (or still running) isn't a problem, so it
  // shouldn't compete for attention the way a real error does.
  const hasActionable = center.notifications.some((n) => n.kind === 'error');

  return (
    <View style={styles.container}>
      <Pressable style={styles.bellButton} onPress={() => setOpen((o) => !o)} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
        <Icon path={mdiBellOutline} size={22} color={colors.text} />
        {count > 0 && (
          <View style={[styles.badge, { backgroundColor: hasActionable ? '#dc2626' : '#6b7280' }]}>
            <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
          </View>
        )}
      </Pressable>
      {open && (
        <View style={[styles.panel, { backgroundColor: colors.background, borderColor: withAlpha(colors.text, 0.15) }]}>
          <View style={styles.panelHeader}>
            <Text style={[styles.panelTitle, { color: colors.text }]}>Notifications</Text>
            <View style={styles.panelHeaderActions}>
              {count > 0 && (
                <Pressable onPress={center.clear}>
                  <Text style={[styles.clearAll, { color: colors.accent }]}>Clear all</Text>
                </Pressable>
              )}
              {/* The bell itself toggles open/closed too, but that wasn't obvious - an explicit close button is the clear, discoverable way out of the panel. */}
              <Pressable onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Icon path={mdiClose} size={18} color={colors.subtleText} />
              </Pressable>
            </View>
          </View>
          {count === 0 ? (
            <Text style={[styles.empty, { color: colors.subtleText }]}>Nothing to report.</Text>
          ) : (
            <FlatList
              data={center.notifications}
              keyExtractor={(n) => n.id}
              style={styles.list}
              renderItem={({ item }) => (
                <NotificationRow
                  notification={item}
                  colors={colors}
                  expanded={expandedIds.has(item.id)}
                  onToggleExpand={() => toggleExpand(item.id)}
                  onDismiss={() => center.dismiss(item.id)}
                />
              )}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // position:'relative' (not absolute) - this whole component sits inline
  // in a HeaderRow's right slot; only the dropdown panel below needs to
  // escape normal layout flow (so opening it doesn't push the header
  // taller), anchored to this container.
  container: {
    position: 'relative',
    zIndex: 20,
  },
  bellButton: {
    padding: 2,
  },
  // Bottom-left, not top-right - the bell sits flush against the screen's
  // right edge in every HeaderRow it's used in, so a top-right badge (which
  // needs to overflow past the icon's own top-right corner to read clearly)
  // was landing partly off-screen there instead of just over the icon.
  badge: {
    position: 'absolute',
    bottom: -4,
    left: -6,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: 'white',
    fontSize: 9,
    fontWeight: '700',
  },
  panel: {
    position: 'absolute',
    // The real fix for this panel floating above sibling screen content
    // (TrackList, LibraryScreen's list) lives on HeaderRow's own style, not
    // here - see its doc. This still needs its own z-index higher than the
    // rest of HeaderRow's contents so the panel clears the bell/back-button
    // row it's anchored to, but it was never the thing standing between this
    // panel and the content below the header.
    zIndex: 20,
    top: '100%',
    right: 0,
    marginTop: 8,
    width: 320,
    maxHeight: 420,
    // Without this, maxHeight isn't a real clip boundary on a plain View
    // (default overflow is 'visible') - an expanded long notification could
    // grow the panel straight past it, taking the list's own scrollbar/tail
    // off-screen with it since there's no ancestor scroll region to bring it
    // back into view. This makes maxHeight the hard limit it looks like,
    // leaving `list`'s own maxHeight (below) as the actual scrollable area.
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: 1,
    padding: 8,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  panelHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  clearAll: {
    fontSize: 13,
    fontWeight: '600',
  },
  empty: {
    padding: 16,
    textAlign: 'center',
  },
  list: {
    maxHeight: 380,
  },
  row: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  rowTextColumn: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  rowTime: {
    fontSize: 11,
    marginTop: 2,
  },
  dismissButton: {
    padding: 2,
  },
  detailText: {
    fontSize: 12,
    marginTop: 6,
    marginLeft: 26,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
  },
  actionButton: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  actionText: {
    fontSize: 12,
    fontWeight: '600',
  },
});

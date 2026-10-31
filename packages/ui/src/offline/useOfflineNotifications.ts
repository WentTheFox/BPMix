import { useEffect, useRef } from 'react';
import type { NotificationCenter } from '../notifications/useNotificationCenter';
import type { UseOfflineResult } from './useOffline';

const NOTIFICATION_ID = 'offline-downloads';
const REMOVAL_NOTIFICATION_ID = 'offline-removal';

/**
 * Shows the progress of downloads the person asked for (tracks, or a playlist made available offline) in
 * the notification bell, one entry that follows the whole batch and stays until dismissed once it is done,
 * instead of counting up inside the playlist. Copies kept quietly because they were played don't count.
 * Deleting offline copies gets its own entry the same way. A batch is whatever is downloading from the moment something is queued until nothing is left, so asking
 * for more while it runs just grows it.
 */
export function useOfflineNotifications(offline: UseOfflineResult | null, center: NotificationCenter): void {
  const { upsertProgress, dismiss } = center;
  const state = offline?.state;
  const cancelAll = offline?.cancelAll;
  const removal = useRef<{ total: number; shown: string } | null>(null);
  const batch = useRef<{ downloadedAtStart: number; failedAtStart: number; total: number; cancelled: boolean; shown: string } | null>(null);

  useEffect(() => {
    if (!state) return;
    if (state.removing) {
      const current = (removal.current ??= { total: 0, shown: '' });
      current.total = Math.max(current.total, state.removing.total);
      const key = `${state.removing.done}/${current.total}`;
      if (key !== current.shown) {
        current.shown = key;
        upsertProgress(REMOVAL_NOTIFICATION_ID, 'Removing offline copies', state.removing.done, current.total, false);
      }
    } else if (removal.current) {
      const { total } = removal.current;
      removal.current = null;
      upsertProgress(REMOVAL_NOTIFICATION_ID, 'Removed offline copies', total, total, true, `${total} track${total === 1 ? '' : 's'} removed from this device.`);
    }
    const waiting = state.requestedCount;
    if (waiting > 0) {
      const current = (batch.current ??= { downloadedAtStart: state.downloadedCount, failedAtStart: state.failures.length, total: 0, cancelled: false, shown: '' });
      const finished = Math.max(0, state.downloadedCount - current.downloadedAtStart);
      current.total = Math.max(current.total, finished + waiting);
      // Bytes arriving change the state far more often than anything this shows.
      const key = `${finished}/${current.total}/${state.paused}`;
      if (key === current.shown) return;
      current.shown = key;
      upsertProgress(
        NOTIFICATION_ID,
        'Downloading for offline play',
        Math.min(finished, current.total),
        current.total,
        false,
        state.paused ? 'Waiting for the server…' : undefined,
        cancelAll
          ? {
              label: 'Cancel',
              onPress: () => {
                if (batch.current) batch.current.cancelled = true;
                cancelAll();
              },
            }
          : undefined,
      );
      return;
    }
    const ended = batch.current;
    if (!ended) return;
    batch.current = null;
    if (ended.cancelled) {
      dismiss(NOTIFICATION_ID);
      return;
    }
    const failed = state.failures.slice(ended.failedAtStart);
    upsertProgress(
      NOTIFICATION_ID,
      failed.length > 0 ? 'Downloaded for offline play, with errors' : 'Downloaded for offline play',
      ended.total,
      ended.total,
      true,
      failed.length > 0 ? `${failed.length} track${failed.length === 1 ? '' : 's'} could not be downloaded: ${failed[failed.length - 1]!.message}` : undefined,
    );
  }, [state, cancelAll, upsertProgress, dismiss]);
}

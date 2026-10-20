import {
  addError as addErrorThunk,
  clearAllNotifications,
  dismissNotification,
  runNotificationAction,
  upsertNotification,
} from '@bpmix/core';
import { useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import type { AppNotification } from './types';

export interface NotificationCenter {
  notifications: AppNotification[];
  /** Adds a new one-off error entry, newest first. */
  addError: (title: string, detail?: string) => void;
  /**
   * Creates or updates a 'progress' entry by id - the metadata scan/lyrics
   * match's own onProgress-style callbacks fire many times over a run, so
   * this upserts in place rather than appending a fresh row per call.
   * Passing `done: true` leaves the finished entry in the list (not
   * auto-removed) until the user dismisses it, so a completed background
   * pass doesn't just silently vanish.
   */
  upsertProgress: (
    id: string,
    title: string,
    current: number,
    total: number,
    done?: boolean,
    detail?: string,
    action?: AppNotification['action'],
  ) => void;
  /** Creates or replaces a 'progress' entry by id from a full description (keeps its original createdAt) - upsertProgress's positional form, plus `status`. */
  upsert: (entry: Omit<AppNotification, 'kind' | 'createdAt'>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

/**
 * View over the store's `notifications` slice (see @bpmix/core's
 * store/notifications) for NotificationBell - session-only (not persisted
 * across a reload), shared between mobile/web so a future tweak to what
 * counts as a notification can't drift between the two apps. The slice only
 * holds an action's label; the callback is looked up by id when pressed.
 *
 * Every function here is stable across renders (they only depend on
 * `dispatch`), so callers can list one as an effect dependency without
 * re-running it on each notification update.
 */
export function useNotificationCenter(): NotificationCenter {
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.notifications.items);

  const notifications = useMemo<AppNotification[]>(
    () =>
      items.map(({ actionLabel, ...rest }) => ({
        ...rest,
        action: actionLabel ? { label: actionLabel, onPress: () => runNotificationAction(rest.id) } : undefined,
      })),
    [items],
  );

  const addError = useCallback((title: string, detail?: string) => dispatch(addErrorThunk(title, detail)), [dispatch]);
  const upsert = useCallback((entry: Omit<AppNotification, 'kind' | 'createdAt'>) => dispatch(upsertNotification(entry)), [dispatch]);
  const upsertProgress = useCallback(
    (id: string, title: string, current: number, total: number, done = false, detail?: string, action?: AppNotification['action']) =>
      dispatch(upsertNotification({ id, title, detail, progress: { current, total, done }, action })),
    [dispatch],
  );
  const dismiss = useCallback((id: string) => dispatch(dismissNotification(id)), [dispatch]);
  const clear = useCallback(() => dispatch(clearAllNotifications()), [dispatch]);

  return useMemo(
    () => ({ notifications, addError, upsertProgress, upsert, dismiss, clear }),
    [notifications, addError, upsertProgress, upsert, dismiss, clear],
  );
}

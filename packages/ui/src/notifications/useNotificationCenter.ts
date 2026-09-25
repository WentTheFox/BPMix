import { logLibraryAction } from '@bpmix/core';
import { useCallback, useMemo, useState } from 'react';
import type { AppNotification } from './types';

/** Generates a reasonably-unique id without depending on crypto.randomUUID (not available in every RN JS engine). */
function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
 * Backing store for NotificationBell - session-only (not persisted across a
 * reload), shared shape between mobile/web so a future tweak to what counts
 * as a notification can't drift between the two apps the way ad hoc
 * setError(errorMessage(err)) calls already had (a raw browser/native error
 * string dumped as the *entire* user-visible message, e.g. "A requested
 * file or directory could not be found at the time an operation was
 * processed" with zero surrounding context).
 */
export function useNotificationCenter(): NotificationCenter {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const addError = useCallback((title: string, detail?: string) => {
    // Every one-shot error surfaced through the notification bell funnels
    // through here regardless of which call site raised it, so logging once
    // here (rather than at each individual setError/addError call site
    // across both apps) covers all of them - see playbackLog.ts's own doc
    // for why this permanent logging exists at all.
    logLibraryAction('notification:error', detail ? { title, detail } : { title });
    setNotifications((prev) => [{ id: makeId(), kind: 'error', title, detail, createdAt: Date.now() }, ...prev]);
  }, []);

  const upsert = useCallback((fields: Omit<AppNotification, 'kind' | 'createdAt'>) => {
    setNotifications((prev) => {
      const existingIndex = prev.findIndex((n) => n.id === fields.id);
      const createdAt = existingIndex !== -1 ? prev[existingIndex]!.createdAt : Date.now();
      const entry: AppNotification = { ...fields, kind: 'progress', createdAt };
      if (existingIndex === -1) return [entry, ...prev];
      const next = [...prev];
      next[existingIndex] = entry;
      return next;
    });
  }, []);

  const upsertProgress = useCallback(
    (id: string, title: string, current: number, total: number, done = false, detail?: string, action?: AppNotification['action']) =>
      upsert({ id, title, detail, progress: { current, total, done }, action }),
    [upsert],
  );

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  return useMemo(
    () => ({ notifications, addError, upsertProgress, upsert, dismiss, clear }),
    [notifications, addError, upsertProgress, upsert, dismiss, clear],
  );
}

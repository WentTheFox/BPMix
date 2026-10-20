import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { logLibraryAction } from '../../playback/playbackLog';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import { clearNotificationActions, setNotificationAction } from './notificationActions';
import { errorAdded, notificationDismissed, notificationsCleared, progressUpserted } from './notificationsSlice';
import type { ProgressUpsert } from './notificationsSlice';

type AppThunk = ThunkAction<void, RootState, Services, UnknownAction>;

/** A progress entry as callers describe it - with the live action callback, which the registry (not state) holds. */
export type ProgressNotification = Omit<ProgressUpsert, 'actionLabel'> & { action?: { label: string; onPress: () => void } };

/** Generates a reasonably-unique id without depending on crypto.randomUUID (not available in every RN JS engine). */
function makeId(now: number): string {
  return `${now}-${Math.random().toString(36).slice(2)}`;
}

/** Adds a new one-off error entry, newest first. */
export function addError(title: string, detail?: string): AppThunk {
  return (dispatch, _getState, { now }) => {
    // Every one-shot error surfaced through the notification bell funnels
    // through here regardless of which call site raised it, so logging once
    // here (rather than at each individual call site across both apps)
    // covers all of them - see playbackLog.ts's own doc for why this
    // permanent logging exists at all.
    logLibraryAction('notification:error', detail ? { title, detail } : { title });
    const createdAt = now();
    dispatch(errorAdded({ id: makeId(createdAt), kind: 'error', title, detail, createdAt }));
  };
}

/**
 * Creates or replaces a 'progress' entry by id. Passing `progress.done` leaves
 * the finished entry in the list until dismissed, so a completed background
 * pass doesn't just silently vanish.
 */
export function upsertNotification(entry: ProgressNotification): AppThunk {
  return (dispatch, _getState, { now }) => {
    const { action, ...rest } = entry;
    setNotificationAction(entry.id, action?.onPress);
    dispatch(progressUpserted({ entry: { ...rest, actionLabel: action?.label }, now: now() }));
  };
}

export function dismissNotification(id: string): AppThunk {
  return (dispatch) => {
    setNotificationAction(id, undefined);
    dispatch(notificationDismissed(id));
  };
}

export function clearAllNotifications(): AppThunk {
  return (dispatch) => {
    clearNotificationActions();
    dispatch(notificationsCleared());
  };
}

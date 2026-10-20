import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

/**
 * One entry in the notification bell's list - either a one-off error or a
 * long-running background operation's live status, upserted by id as it
 * progresses rather than appended fresh each time.
 *
 * Serializable on purpose: an entry's action callback can't live in state,
 * so only its label does (`actionLabel`) - the callback sits in
 * notificationActions.ts, keyed by the same id.
 */
export interface NotificationEntry {
  id: string;
  kind: 'error' | 'progress';
  /** Short, human-readable summary - what the bell's collapsed list shows. */
  title: string;
  /** Full detail shown once a list item is expanded (the raw error message for an 'error'). */
  detail?: string;
  createdAt: number;
  /** 'progress' kind only. `done` entries stay in the list until dismissed. */
  progress?: { current: number; total: number; done: boolean };
  /** Label of the secondary action rendered on the row (e.g. "Cancel"); see notificationActions.ts for the callback. */
  actionLabel?: string;
  /** 'progress' kind only - 'queued' before it first starts, 'paused' while a background pass yields to foreground work (see taskQueue.ts). */
  status?: 'queued' | 'paused';
}

export interface NotificationsState {
  /** Newest first. */
  items: NotificationEntry[];
}

const initialState: NotificationsState = { items: [] };

export type ProgressUpsert = Omit<NotificationEntry, 'kind' | 'createdAt'>;

export const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    errorAdded(state, action: PayloadAction<NotificationEntry>) {
      state.items.unshift(action.payload);
    },
    /** Creates or replaces a 'progress' entry by id (keeping its original createdAt). `now` is used only for a new entry. */
    progressUpserted(state, action: PayloadAction<{ entry: ProgressUpsert; now: number }>) {
      const { entry, now } = action.payload;
      const index = state.items.findIndex((n) => n.id === entry.id);
      const createdAt = index !== -1 ? state.items[index]!.createdAt : now;
      const next: NotificationEntry = { ...entry, kind: 'progress', createdAt };
      if (index === -1) state.items.unshift(next);
      else state.items[index] = next;
    },
    notificationDismissed(state, action: PayloadAction<string>) {
      state.items = state.items.filter((n) => n.id !== action.payload);
    },
    notificationsCleared(state) {
      state.items = [];
    },
  },
});

export const { errorAdded, progressUpserted, notificationDismissed, notificationsCleared } = notificationsSlice.actions;

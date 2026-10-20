import type { Dispatch, ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';
import { getTasks, subscribeTasks } from '../../tasks/taskQueue';
import type { TaskInfo } from '../../tasks/taskQueue';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import { dismissNotification, upsertNotification } from './notificationsThunks';

/** How long a finished task with a known total stays on screen as "done" before it's dismissed on its own. */
export const DONE_AUTO_DISMISS_MS = 4000;

/** Lower is more active - which of several same-id tasks a notification shows. */
const STATE_RANK: Record<TaskInfo['state'], number> = { running: 0, paused: 1, queued: 2 };

type AppDispatch = ThunkDispatch<RootState, Services, UnknownAction> & Dispatch<UnknownAction>;

export interface TaskSource {
  getTasks: () => TaskInfo[];
  subscribe: (listener: () => void) => () => void;
}

const defaultSource: TaskSource = { getTasks, subscribe: subscribeTasks };

/**
 * Mirrors the shared task queue (taskQueue.ts) into the notification list:
 * one entry per queued/running/paused task - folder scans (Add Folder,
 * Rescan, background refresh), the Unplaylisted walk, metadata and lyrics
 * passes - with live progress, a Queued/Paused marker while it's waiting
 * its turn, and Cancel where the task supports it. Driven by the queue
 * itself rather than per-feature wiring, so every new queued task gets a
 * notification for free.
 *
 * A finished task that had a known total is left on screen as "done"
 * briefly (so a completed pass doesn't just vanish); anything else is
 * dismissed as soon as it finishes.
 *
 * Returns the unsubscribe function (also cancels pending auto-dismisses).
 */
export function syncTaskNotifications(dispatch: AppDispatch, source: TaskSource = defaultSource): () => void {
  let previous = new Map<string, TaskInfo>();
  // Pending "done" auto-dismisses by id - cancelled if a new task with the
  // same id (e.g. rescanning the same folder) starts before it fires.
  const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const process = () => {
    // Several tasks can share an id - e.g. a refresh() requesting a new
    // lyrics pass while one is already running queues a second
    // 'lyrics-match' behind it. Show the most active one: otherwise the
    // queued duplicate (no progress yet) would overwrite the running pass's
    // entry, so the notification would read "Queued" while matching was
    // visibly progressing elsewhere.
    const current = new Map<string, TaskInfo>();
    for (const task of source.getTasks()) {
      const existing = current.get(task.id);
      if (!existing || STATE_RANK[task.state] < STATE_RANK[existing.state]) current.set(task.id, task);
    }
    for (const [id, task] of previous) {
      if (current.has(id)) continue;
      const total = task.progress?.total ?? 0;
      if (total > 0) {
        dispatch(upsertNotification({ id, title: task.label, progress: { current: total, total, done: true } }));
        dismissTimers.set(
          id,
          setTimeout(() => {
            dismissTimers.delete(id);
            dispatch(dismissNotification(id));
          }, DONE_AUTO_DISMISS_MS),
        );
      } else {
        dispatch(dismissNotification(id));
      }
    }
    for (const task of current.values()) {
      clearTimeout(dismissTimers.get(task.id));
      dismissTimers.delete(task.id);
      const detail = task.progress?.detail;
      dispatch(
        upsertNotification({
          id: task.id,
          title: detail ? `${task.label} - ${detail}` : task.label,
          progress: { current: task.progress?.current ?? 0, total: task.progress?.total ?? 0, done: false },
          status: task.state === 'running' ? undefined : task.state,
          action: task.cancel ? { label: 'Cancel', onPress: task.cancel } : undefined,
        }),
      );
    }
    previous = current;
  };

  const unsubscribe = source.subscribe(process);
  process();
  return () => {
    unsubscribe();
    for (const timer of dismissTimers.values()) clearTimeout(timer);
    dismissTimers.clear();
  };
}

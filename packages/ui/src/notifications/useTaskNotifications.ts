import { getTasks, subscribeTasks, type TaskInfo } from '@bpmix/core';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { NotificationCenter } from './useNotificationCenter';

/** How long a finished task with a known total stays on screen as "done" before it's dismissed on its own. */
const DONE_AUTO_DISMISS_MS = 4000;

/**
 * Mirrors @bpmix/core's shared task queue (taskQueue.ts) into the
 * notification bell: one entry per queued/running/paused task - folder
 * scans (Add Folder, Rescan, background refresh), the Unplaylisted walk,
 * metadata and lyrics passes - with live progress, a Queued/Paused marker
 * while it's waiting its turn, and Cancel where the task supports it.
 * Driven by the queue itself rather than per-feature wiring, so every new
 * queued task gets a notification for free - the initial folder scan and
 * the Unplaylisted walk both previously had none.
 *
 * A finished task that had a known total is left on screen as "done"
 * briefly (so a completed pass doesn't just vanish); anything else is
 * dismissed as soon as it finishes.
 */
export function useTaskNotifications(notificationCenter: NotificationCenter): void {
  // upsert/dismiss are stable (useCallback with no deps in
  // useNotificationCenter) - the notificationCenter object itself isn't,
  // and depending on it would re-run this effect every time it updates a
  // notification.
  const { upsert, dismiss } = notificationCenter;
  const tasks = useSyncExternalStore(subscribeTasks, getTasks, getTasks);
  const previousRef = useRef<Map<string, TaskInfo>>(new Map());
  // Pending "done" auto-dismisses by id - cancelled if a new task with the
  // same id (e.g. rescanning the same folder) starts before it fires.
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = dismissTimersRef.current;
    const current = new Map(tasks.map((task) => [task.id, task]));
    for (const [id, task] of previousRef.current) {
      if (current.has(id)) continue;
      const total = task.progress?.total ?? 0;
      if (total > 0) {
        upsert({ id, title: task.label, progress: { current: total, total, done: true } });
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            dismiss(id);
          }, DONE_AUTO_DISMISS_MS),
        );
      } else {
        dismiss(id);
      }
    }
    for (const task of tasks) {
      clearTimeout(timers.get(task.id));
      timers.delete(task.id);
      const detail = task.progress?.detail;
      upsert({
        id: task.id,
        title: detail ? `${task.label} - ${detail}` : task.label,
        progress: { current: task.progress?.current ?? 0, total: task.progress?.total ?? 0, done: false },
        status: task.state === 'running' ? undefined : task.state,
        action: task.cancel ? { label: 'Cancel', onPress: task.cancel } : undefined,
      });
    }
    previousRef.current = current;
  }, [tasks, upsert, dismiss]);
}

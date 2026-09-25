/**
 * One entry in the notification bell's list - either a one-off error (a
 * decode failure, a permission problem, anything that used to be a
 * transient "here's a raw error string" banner - see AppTitle-adjacent
 * NotificationBell) or a long-running background operation's live status
 * (the metadata scan, the lyrics auto-match pass), which is upserted by id
 * as it progresses rather than appended fresh each time.
 */
export interface AppNotification {
  id: string;
  kind: 'error' | 'progress';
  /** Short, human-readable summary - what the bell's collapsed list shows. */
  title: string;
  /**
   * Full detail, shown once a list item is expanded - the actual raw error
   * message/stack for an 'error' notification (the thing that used to be
   * dumped verbatim as the title, e.g. "A requested file or directory could
   * not be found at the time an operation was processed" with no context
   * around it), or extra context for a 'progress' one.
   */
  detail?: string;
  createdAt: number;
  /** 'progress' kind only - current/total, and whether this run has finished (kept in the list, not auto-removed, so a completed background pass stays visible until dismissed). */
  progress?: { current: number; total: number; done: boolean };
  /** Optional secondary action rendered on the row (e.g. "Cancel" for an in-progress library scan the user might want to stop) - not tied to a specific kind, so any notification can carry one. Caller owns dismissing/updating the notification once the action's effect actually lands (e.g. once a cancelled scan's promise actually rejects), this doesn't do that itself. */
  action?: { label: string; onPress: () => void };
  /** 'progress' kind only - set while the operation is waiting its turn on the task queue (see @bpmix/core's taskQueue.ts): 'queued' before it first starts, 'paused' while a background pass has yielded to foreground work. */
  status?: 'queued' | 'paused';
}

/**
 * Process-wide queue for every long-running library task (folder scans,
 * the Unplaylisted walk, metadata/lyrics passes), so they take turns
 * instead of racing each other for the same file APIs - on Windows in
 * particular, overlapping storage-broker reads and full-library store
 * writes made the whole system sluggish (see FileAccessModule.h and
 * libraryStore.windows.ts).
 *
 * Exactly one task holds the queue at a time. Two priorities:
 *  - 'foreground': something the user is actively waiting on (Add Folder,
 *    Rescan, opening Unplaylisted). Runs to completion once started;
 *    queued foreground tasks run in request order.
 *  - 'background': long, resumable passes (metadata scan, lyrics
 *    matching). They call `checkpoint()` between items; if a foreground
 *    task is waiting at that moment, the background task pauses there -
 *    handing the queue over - and resumes where it left off once no
 *    foreground work is left. Background tasks run one at a time too.
 *
 * Not for the startup restore path (see CLAUDE.md) - resolving the
 * last-played playlist and its current track must never wait on this.
 *
 * Don't await one task from inside another's body - the inner one can't
 * start until the outer one finishes, so that would deadlock.
 */

export type TaskPriority = 'foreground' | 'background';
export type TaskState = 'queued' | 'running' | 'paused';

export interface TaskProgress {
  /** Short status text appended to the label (e.g. "1234 files in 56 folders"), or '' for none. */
  detail: string;
  current: number;
  /** 0 when there's no known total yet. */
  total: number;
}

export interface TaskInfo {
  id: string;
  label: string;
  priority: TaskPriority;
  state: TaskState;
  progress?: TaskProgress;
  /** Present when the task can be cancelled (see runTask's `cancel` option). */
  cancel?: () => void;
}

export interface TaskContext {
  /**
   * Background tasks: await between units of work - resolves immediately
   * unless foreground work is waiting, in which case it pauses until that's
   * all done. A no-op for foreground tasks.
   */
  checkpoint: () => Promise<void>;
  /** Updates this task's displayed progress. Cheap to call per item - listeners are throttled (see PROGRESS_THROTTLE_MS). */
  reportProgress: (progress: TaskProgress) => void;
}

interface Entry extends TaskInfo {
  /** Resolves when this entry is (re)granted the queue. */
  start: () => void;
}

/**
 * Tasks report progress after every file/listing/write - thousands of calls
 * for a big library. Subscribers (a notification re-render each) hear about
 * progress changes at most this often; state changes (queued -> running ->
 * paused, a task finishing) are published immediately.
 */
const PROGRESS_THROTTLE_MS = 250;
let lastProgressPublishAt = 0;
let pendingPublish: ReturnType<typeof setTimeout> | undefined;

let holder: Entry | null = null;
/** Waiting entries (queued or paused), in the order they'll be granted within their priority. */
let waiting: Entry[] = [];
const listeners = new Set<() => void>();
let snapshot: TaskInfo[] = [];

function publish(): void {
  clearTimeout(pendingPublish);
  pendingPublish = undefined;
  lastProgressPublishAt = Date.now();
  const all = holder ? [holder, ...waiting] : [...waiting];
  snapshot = all.map(({ id, label, priority, state, progress, cancel }) => ({ id, label, priority, state, progress, cancel }));
  for (const listener of listeners) listener();
}

function publishProgressThrottled(): void {
  const sinceLast = Date.now() - lastProgressPublishAt;
  if (sinceLast >= PROGRESS_THROTTLE_MS) publish();
  else if (pendingPublish === undefined) pendingPublish = setTimeout(publish, PROGRESS_THROTTLE_MS - sinceLast);
}

function pump(): void {
  if (!holder) {
    const next = waiting.find((e) => e.priority === 'foreground') ?? waiting[0];
    if (next) {
      waiting = waiting.filter((e) => e !== next);
      holder = next;
      next.state = 'running';
      next.start();
    }
  }
  publish();
}

/** Every task currently queued, running or paused, holder first - a stable array reference that only changes when something does (useSyncExternalStore-safe). */
export function getTasks(): TaskInfo[] {
  return snapshot;
}

/** Fires on every task state change. Returns an unsubscribe function. */
export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Queues `body` and runs it once it's this task's turn (see the module doc
 * for ordering). `id` is for display only (e.g. a notification id) - two
 * tasks with the same id are still two separate tasks. `cancel`, when
 * given, is exposed on TaskInfo for a Cancel button; making `body` actually
 * stop is the caller's job, via `signal`: if it aborts while the task is
 * still queued, the task leaves the queue right away and `body` runs once,
 * unqueued, so it can check the signal and throw its own cancellation
 * error (instead of a cancelled task waiting out everything ahead of it).
 */
export function runTask<T>(
  options: { id: string; label: string; priority: TaskPriority; cancel?: () => void; signal?: AbortSignal },
  body: (context: TaskContext) => Promise<T>,
): Promise<T> {
  let start!: () => void;
  const { signal, ...info } = options;
  const entry: Entry = { ...info, state: 'queued', start: () => start() };

  const reportProgress = (progress: TaskProgress): void => {
    entry.progress = progress;
    publishProgressThrottled();
  };
  const turn = () => new Promise<void>((resolve) => (start = resolve));

  const checkpoint = async (): Promise<void> => {
    if (entry.priority !== 'background' || holder !== entry) return;
    if (!waiting.some((e) => e.priority === 'foreground')) return;
    // Yield: go back to the front of the background line (ahead of any
    // background task that hasn't started yet), let the foreground work
    // run, and continue once pump() hands the queue back.
    holder = null;
    entry.state = 'paused';
    const firstBackground = waiting.findIndex((e) => e.priority === 'background');
    waiting.splice(firstBackground === -1 ? waiting.length : firstBackground, 0, entry);
    const resumed = turn();
    pump();
    await resumed;
  };

  if (signal?.aborted) return body({ checkpoint: async () => {}, reportProgress: () => {} });

  const started = turn();
  waiting.push(entry);
  signal?.addEventListener('abort', () => {
    if (entry.state !== 'queued' || !waiting.includes(entry)) return;
    waiting = waiting.filter((e) => e !== entry);
    start();
    publish();
  });
  pump();

  return started
    .then(() => body({ checkpoint, reportProgress }))
    .finally(() => {
      if (holder === entry) holder = null;
      waiting = waiting.filter((e) => e !== entry);
      pump();
    });
}

const latestById = new Map<string, { token: object; controller: AbortController }>();

/**
 * runTask for repeatable passes where only the newest request matters (e.g.
 * the metadata scan every refresh() kicks off): a newer request with the
 * same id supersedes an older one that hasn't started yet - it leaves the
 * queue immediately and resolves without running. One that's already
 * running is left to finish.
 */
export function runLatestTask(
  options: { id: string; label: string; priority: TaskPriority },
  body: (context: TaskContext) => Promise<void>,
): Promise<void> {
  const token = {};
  const controller = new AbortController();
  latestById.get(options.id)?.controller.abort();
  latestById.set(options.id, { token, controller });
  return runTask({ ...options, signal: controller.signal }, async (context) => {
    if (latestById.get(options.id)?.token !== token) return;
    await body(context);
  }).finally(() => {
    if (latestById.get(options.id)?.token === token) latestById.delete(options.id);
  });
}

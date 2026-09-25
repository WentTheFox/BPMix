import type { FileAccess } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import { runTask, type TaskProgress } from '../tasks/taskQueue';
import { scanRoot, type ScanProgress, type ScanResult } from './scan';

interface ActiveScan {
  promise: Promise<ScanResult>;
  abort: () => void;
}

/**
 * Module-level (not per-hook-instance) state, deliberately - a root can be
 * scanned by two entirely separate call sites that don't know about each
 * other: an automatic background refresh (apps/*'s App.tsx refresh(), which
 * runs on mount/focus with no user gesture) and a user clicking "Rescan" via
 * useLibraryRootActions. Confirmed live: without this, both could call
 * scanRoot() for the same rootId at once, each independently walking the
 * whole tree and upserting into the store - wasted work at best, and a
 * confusing double-cancel/interleaved-progress UI at worst, since neither
 * side has any way to know the other is already scanning the same root.
 */
const activeScans = new Map<string, ActiveScan>();
const listeners = new Set<() => void>();
let activeRootIdsSnapshot: string[] = [];

function refreshSnapshot(): void {
  activeRootIdsSnapshot = [...activeScans.keys()];
  for (const listener of listeners) listener();
}

/** True while any caller's scan of this root (background or user-triggered) is in flight. */
export function isRootScanning(rootId: string): boolean {
  return activeScans.has(rootId);
}

/**
 * Every currently-scanning root id, as a stable array reference that only
 * changes when the active set actually does - suitable for React's
 * useSyncExternalStore, which re-renders on any getSnapshot() result that
 * fails Object.is against the previous one (a fresh array every call would
 * mean a needless render on every single render, not just on real changes).
 */
export function getActiveScanRootIds(): string[] {
  return activeRootIdsSnapshot;
}

/** Subscribes to changes in which roots are scanning - fires on every scan start/finish (own or another caller's). Returns an unsubscribe function. */
export function subscribeScanning(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** No-op if rootId isn't currently scanning (already finished, or never started) - callers don't need to check isRootScanning first. */
export function cancelRootScan(rootId: string): void {
  activeScans.get(rootId)?.abort();
}

/**
 * Runs scanRoot for rootId, joining an already-in-flight scan of the same
 * root instead of starting a duplicate one - see the module doc for why
 * that matters. A caller that joins an existing scan gets its result (or
 * its ScanCancelledError, if whoever's driving it - possibly a different
 * caller - cancels it) rather than its own independent run.
 *
 * The scan itself runs as a 'foreground' task on the shared task queue
 * (see taskQueue.ts), so it waits its turn behind other folder scans and
 * pauses background passes (metadata, lyrics) instead of racing them; the
 * queue is also what shows its progress/Cancel in the notification bell.
 * `displayName` labels it there - a freshly added folder's first scan
 * runs before the root shows up anywhere else its name could be looked up.
 */
export function scanRootCoordinated(fileAccess: FileAccess, store: LibraryStore, rootId: string, displayName?: string): Promise<ScanResult> {
  const existing = activeScans.get(rootId);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const promise = runTask(
    {
      id: `scanning-${rootId}`,
      label: `Scanning "${displayName ?? rootId}"`,
      priority: 'foreground',
      cancel: () => controller.abort(),
      signal: controller.signal,
    },
    ({ reportProgress }) => scanRoot(fileAccess, store, rootId, controller.signal, (p) => reportProgress(describeScanProgress(p))),
  ).finally(() => {
    activeScans.delete(rootId);
    refreshSnapshot();
  });
  activeScans.set(rootId, { promise, abort: () => controller.abort() });
  refreshSnapshot();
  return promise;
}

/** Turns a scan's raw progress into the task queue's display shape. */
export function describeScanProgress(progress: ScanProgress): TaskProgress {
  switch (progress.phase) {
    case 'listing': {
      const folders = `${progress.foldersListed} folder${progress.foldersListed === 1 ? '' : 's'}`;
      return { detail: `${progress.filesFound} files in ${folders}`, current: 0, total: 0 };
    }
    case 'playlists':
      return { detail: 'reading playlists', current: progress.current, total: progress.total };
    case 'saving':
      return { detail: 'saving library', current: progress.current, total: progress.total };
  }
}

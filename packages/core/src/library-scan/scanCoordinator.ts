import type { FileAccess } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import { scanRoot, type ScanProgress, type ScanResult } from './scan';

interface ActiveScan {
  promise: Promise<ScanResult>;
  abort: () => void;
  /** See scanRootCoordinated's displayName param. */
  displayName?: string;
  getProgress: () => ScanProgress | undefined;
}

/**
 * scanRoot reports progress after every listing/read/write - thousands of
 * calls for a big library. Listeners (a notification re-render each) get at
 * most one update per this interval per root, plus one immediately on every
 * phase change so a switch from "listing" to "reading playlists" never
 * lags behind.
 */
const PROGRESS_THROTTLE_MS = 250;

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
const progressListeners = new Set<(rootId: string, progress: ScanProgress) => void>();
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

/** The latest (unthrottled) progress of rootId's in-flight scan, or undefined if it isn't scanning or hasn't reported anything yet. */
export function getScanProgress(rootId: string): ScanProgress | undefined {
  return activeScans.get(rootId)?.getProgress();
}

/** The display name whoever started rootId's in-flight scan passed in, if any - see scanRootCoordinated's displayName param. */
export function getScanDisplayName(rootId: string): string | undefined {
  return activeScans.get(rootId)?.displayName;
}

/** Subscribes to throttled progress updates (see PROGRESS_THROTTLE_MS) for every in-flight scan. Start/finish still come through subscribeScanning, not this. Returns an unsubscribe function. */
export function subscribeScanProgress(listener: (rootId: string, progress: ScanProgress) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
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
 * `displayName` is for progress UI: a freshly added folder's very first
 * scan runs before the root shows up anywhere else the UI could look its
 * name up from (apps/*'s grantedRoots only refreshes once the scan is done).
 */
export function scanRootCoordinated(fileAccess: FileAccess, store: LibraryStore, rootId: string, displayName?: string): Promise<ScanResult> {
  const existing = activeScans.get(rootId);
  if (existing) return existing.promise;

  const controller = new AbortController();
  // What getScanProgress returns - listeners only see it on the throttled
  // emit schedule below.
  let latest: ScanProgress | undefined;
  let lastEmitAt = 0;
  let pendingEmit: ReturnType<typeof setTimeout> | undefined;
  const emit = () => {
    pendingEmit = undefined;
    lastEmitAt = Date.now();
    if (latest) for (const listener of progressListeners) listener(rootId, latest);
  };
  const onProgress = (progress: ScanProgress) => {
    const phaseChanged = latest?.phase !== progress.phase;
    latest = progress;
    if (phaseChanged || Date.now() - lastEmitAt >= PROGRESS_THROTTLE_MS) {
      clearTimeout(pendingEmit);
      emit();
    } else if (pendingEmit === undefined) {
      pendingEmit = setTimeout(emit, PROGRESS_THROTTLE_MS - (Date.now() - lastEmitAt));
    }
  };

  const promise = scanRoot(fileAccess, store, rootId, controller.signal, onProgress).finally(() => {
    clearTimeout(pendingEmit);
    activeScans.delete(rootId);
    refreshSnapshot();
  });
  activeScans.set(rootId, { promise, abort: () => controller.abort(), displayName, getProgress: () => latest });
  refreshSnapshot();
  return promise;
}

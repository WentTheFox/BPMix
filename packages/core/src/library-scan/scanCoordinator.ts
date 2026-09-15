import type { FileAccess } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import { scanRoot, type ScanResult } from './scan';

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
 */
export function scanRootCoordinated(fileAccess: FileAccess, store: LibraryStore, rootId: string): Promise<ScanResult> {
  const existing = activeScans.get(rootId);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const promise = scanRoot(fileAccess, store, rootId, controller.signal).finally(() => {
    activeScans.delete(rootId);
    refreshSnapshot();
  });
  activeScans.set(rootId, { promise, abort: () => controller.abort() });
  refreshSnapshot();
  return promise;
}

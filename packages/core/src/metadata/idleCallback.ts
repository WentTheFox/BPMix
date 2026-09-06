export interface IdleDeadline {
  didTimeout: boolean;
  timeRemaining(): number;
}

/** Synthetic per-callback budget used when no real requestIdleCallback exists (see requestIdle's doc). */
const FALLBACK_BUDGET_MS = 50;

/**
 * Schedules `callback` for the next idle period, real (RN >= 0.63 and
 * browsers both expose requestIdleCallback as a global) or approximated.
 * The fallback (Node/Vitest, or any environment without the global) runs on
 * the next macrotask with a fixed time budget rather than genuine idle
 * detection - not real idle scheduling, but it keeps the deadline-driven
 * chunking pattern (see scanLibraryMetadata) working identically in tests
 * without a special-cased test environment branch.
 */
export function requestIdle(callback: (deadline: IdleDeadline) => void, timeoutMs?: number): void {
  const native = (globalThis as { requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof native === 'function') {
    native(callback, timeoutMs !== undefined ? { timeout: timeoutMs } : undefined);
    return;
  }
  setTimeout(() => {
    const startedAtMs = Date.now();
    callback({
      didTimeout: false,
      timeRemaining: () => Math.max(0, FALLBACK_BUDGET_MS - (Date.now() - startedAtMs)),
    });
  }, 0);
}

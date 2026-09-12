import { logMemorySnapshot } from '@bpmix/core';
import { useEffect } from 'react';

const DEFAULT_INTERVAL_MS = 45_000;

/**
 * Periodically logs a best-effort memory snapshot (see logMemorySnapshot)
 * while something is actually loaded - idle at app startup/on the bare
 * library screen logs nothing, so this doesn't add a permanent background
 * timer's worth of noise to a session that never plays anything. Shared
 * between mobile and web (both call this once) rather than each running its
 * own interval, so the cadence/gating logic can't drift between them - see
 * playbackLog.ts's own doc for why this permanent logging exists at all.
 */
export function useMemoryUsageLogging(isActive: boolean, intervalMs = DEFAULT_INTERVAL_MS): void {
  useEffect(() => {
    if (!isActive) return;
    const handle = setInterval(() => logMemorySnapshot('periodic'), intervalMs);
    return () => clearInterval(handle);
  }, [isActive, intervalMs]);
}

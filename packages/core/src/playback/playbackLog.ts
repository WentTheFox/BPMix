/**
 * Permanent, lightweight diagnostic logging for playback state transitions
 * and seeks - deliberately left in the shipped app (not temporary debug
 * instrumentation to be cleaned up), so a future timing-sensitive bug (a
 * memory leak, a race between two transitions, an unexpected track change)
 * can be correlated against exactly what PlaylistPlayer did and when,
 * without needing to reproduce it live first. Added after a real Hermes
 * heap-OOM crash (2026-09-10) where the only evidence available after the
 * fact was the native crash log - no way to tell which sequence of track
 * loads/seeks led up to it.
 *
 * Tagged so it's easy to filter: `adb logcat | grep BPMix:playback` on
 * Android, or the same string in the Chrome/Hermes debugger console on any
 * platform.
 */
const TAG = '[BPMix:playback]';

export function logPlayback(event: string, details?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  if (details) console.log(TAG, new Date().toISOString(), event, details);
  // eslint-disable-next-line no-console
  else console.log(TAG, new Date().toISOString(), event);
}

/**
 * Hermes-only (Android/Windows via Hermes; no-op on web, which runs on the
 * browser's own JS engine, not Hermes) - logs the engine's own heap/GC
 * counters alongside a playback event, so a growing "external" or heap
 * figure across many decode/playAt log lines can be spotted directly in
 * `adb logcat` without attaching a separate profiler. Added specifically
 * to help correlate with the 2026-09-10 Hermes heap-OOM crash
 * (`HermesGC: OOM: ... external = 3650422910`), whose only trace afterward
 * was the native crash log itself.
 */
export function logPlaybackWithHeapStats(event: string, details?: Record<string, unknown>): void {
  const hermes = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> } }).HermesInternal;
  const heapStats = hermes?.getInstrumentedStats?.();
  logPlayback(event, heapStats ? { ...details, heapStats } : details);
}

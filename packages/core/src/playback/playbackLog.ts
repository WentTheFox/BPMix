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

/**
 * Renders details as a single trailing JSON blob rather than passing the
 * object as its own console.log argument - a live object only expands
 * usefully in an attached interactive console (Chrome DevTools, a
 * connected Hermes debugger); everywhere else this log is actually read
 * from - piped/grepped adb logcat output, a captured text log, browser
 * automation reading console messages - it collapses to a useless literal
 * "Object" with no way to recover the fields. One self-contained string
 * per call keeps every consumer equally readable.
 */
function formatDetails(details?: Record<string, unknown>): string {
  return details ? ` ${JSON.stringify(details)}` : '';
}

export function logPlayback(event: string, details?: Record<string, unknown>): void {
  console.log(`${TAG} ${new Date().toISOString()} ${event}${formatDetails(details)}`);
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
  const heapStats = readHermesHeapStats();
  logPlayback(event, heapStats ? { ...details, heapStats } : details);
}

function readHermesHeapStats(): Record<string, unknown> | undefined {
  const hermes = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> } }).HermesInternal;
  return hermes?.getInstrumentedStats?.();
}

/**
 * Same permanent-logging rationale as logPlayback above, for library/lyrics
 * folder management actions (add/remove/rescan a root or lyrics scope) -
 * kept as a separate tag so it can be filtered independently of the
 * higher-volume playback log, since these are rarer, user-initiated actions
 * rather than continuous transport state.
 */
const LIBRARY_TAG = '[BPMix:library]';

export function logLibraryAction(event: string, details?: Record<string, unknown>): void {
  console.log(`${LIBRARY_TAG} ${new Date().toISOString()} ${event}${formatDetails(details)}`);
}

/**
 * Best-effort process memory snapshot, logged on its own tag so a growing
 * trend can be grepped independently of individual playback events (see
 * logPlaybackWithHeapStats for memory attached to a specific action instead
 * of sampled periodically). Two sources, in priority order:
 *
 * - Hermes' own instrumented stats (Android/Windows) - the same source
 *   logPlaybackWithHeapStats uses, including heap size/used and (per that
 *   function's own doc) the "external" figure implicated in a prior real
 *   Hermes heap-OOM crash.
 * - `performance.memory` (Chromium/web only - not a standard API, absent on
 *   Firefox/Safari and in RN's own JS environment).
 *
 * Silently skipped (no log line at all) when neither is available, rather
 * than logging an "unsupported" line every call - a periodic caller (see
 * packages/ui's useMemoryUsageLogging) would otherwise spam that on every
 * tick on an unsupported platform for the lifetime of the app.
 */
const MEMORY_TAG = '[BPMix:memory]';

export function logMemorySnapshot(reason?: string): void {
  const heapStats = readHermesHeapStats();
  if (heapStats) {
    console.log(`${MEMORY_TAG} ${new Date().toISOString()} hermes ${reason ?? ''}${formatDetails(heapStats)}`);
    return;
  }
  const perf = (globalThis as { performance?: { memory?: Record<string, unknown> } }).performance;
  if (perf?.memory) {
    console.log(`${MEMORY_TAG} ${new Date().toISOString()} performance.memory ${reason ?? ''}${formatDetails(perf.memory)}`);
  }
}

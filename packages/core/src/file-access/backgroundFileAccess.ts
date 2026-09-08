import type { FileAccess } from './types';

/**
 * Wraps a FileAccess so every read call is marked "may not prompt" - for
 * background/idle-scheduled passes (matchLibraryLyrics, ensureLyricsAssignment)
 * that have no user gesture behind them to call requestPermission() from; see
 * FileAccessCallOptions.allowPrompt's doc for why that throws instead of
 * prompting.
 *
 * Must be created once per underlying FileAccess and reused, not re-wrapped
 * per call - scanAllLyricsScopes's scan-result cache is keyed by FileAccess
 * *instance identity* (a WeakMap), so a fresh wrapper on every call would be
 * a permanent cache miss.
 */
export function createBackgroundFileAccess(fileAccess: FileAccess): FileAccess {
  return {
    ...fileAccess,
    listDirectory: (rootId, relativePath) => fileAccess.listDirectory(rootId, relativePath, { allowPrompt: false }),
    readFileBytes: (ref) => fileAccess.readFileBytes(ref, { allowPrompt: false }),
    readFileText: (ref) => fileAccess.readFileText(ref, { allowPrompt: false }),
  };
}

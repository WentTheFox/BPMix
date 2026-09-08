import { FileAccessPermissionPendingError, type FileAccess } from '../file-access/types';
import type { LibraryStore, LyricsScope } from '../library-store/types';
import { scanAllLyricsScopes } from './loadAssignedLyrics';
import { findAutoLyricsMatch } from './matchLyrics';

/**
 * Resolves an auto-match lyrics assignment for a single track, a no-op if
 * it already has one (manual or previously auto-matched). This is the
 * critical-path counterpart to matchLibraryLyrics's whole-library,
 * idle-chunked background pass: bounded by lyrics-folder size rather than
 * track count (same "lyrics folders are expected to be small" assumption as
 * loadAssignedLyrics), so it's cheap enough to await on startup for just the
 * track being restored - see usePlaybackPersistence and CLAUDE.md's note on
 * keeping that path narrow.
 */
export async function ensureLyricsAssignment(
  fileAccess: FileAccess,
  store: LibraryStore,
  scopes: LyricsScope[],
  trackFileId: string,
  trackFileName: string,
): Promise<void> {
  if (scopes.length === 0) return;
  const existing = await store.getLyricsAssignment(trackFileId);
  if (existing) return;
  let files;
  try {
    files = await scanAllLyricsScopes(fileAccess, scopes);
  } catch (err) {
    // See matchLibraryLyrics's identical catch for why: a lapsed browser
    // grant can't be re-requested off this non-gesture call - skip quietly
    // rather than crash the startup restore path.
    if (err instanceof FileAccessPermissionPendingError) return;
    throw err;
  }
  const candidates = files.map((file) => ({ fileId: file.id, name: file.name }));
  const match = findAutoLyricsMatch(trackFileName, candidates);
  if (match) await store.putLyricsAssignment(trackFileId, match.fileId);
}

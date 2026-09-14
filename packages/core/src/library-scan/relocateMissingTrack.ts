import type { FileAccess } from '../file-access/types';
import { formatM3u8, parseM3u8, relativizeM3u8EntryPath, resolveM3u8EntryPath } from '../playlist/m3u8';
import { walkDirectory } from './walk';

/**
 * Rewrites every playlist under `rootId` that references `oldRelativePath`
 * (a missing track's expected-but-not-found path - see TrackRecord.missing)
 * to point at `newRelativePath` instead, each expressed relative to that
 * playlist's own location (playlists reference tracks relative to
 * themselves, not the root - see resolveM3u8EntryPath's doc). Returns how
 * many playlists were actually rewritten (0 means no playlist under this
 * root referenced the old path - not necessarily an error, just a no-op).
 *
 * Requires FileAccess.writeFileText, which not every adapter supports yet
 * (Windows, the self-hosted server - see CLAUDE.md's housekeeping TODO) -
 * this throws there rather than silently doing nothing, same as
 * createPlaylistFromFolder's own write.
 */
export async function relocateMissingTrack(
  fileAccess: FileAccess,
  rootId: string,
  oldRelativePath: string,
  newRelativePath: string,
): Promise<number> {
  const { playlistFiles } = await walkDirectory(fileAccess, rootId);
  let rewrittenCount = 0;

  for (const playlistFile of playlistFiles) {
    const text = await fileAccess.readFileText(playlistFile);
    const entries = parseM3u8(text);
    let changed = false;

    const rewritten = entries.map((entry) => {
      if (resolveM3u8EntryPath(playlistFile.relativePath, entry.rawPath) !== oldRelativePath) return entry;
      changed = true;
      return { ...entry, rawPath: relativizeM3u8EntryPath(playlistFile.relativePath, newRelativePath) };
    });

    if (changed) {
      await fileAccess.writeFileText(rootId, playlistFile.relativePath, formatM3u8(rewritten));
      rewrittenCount++;
    }
  }

  return rewrittenCount;
}

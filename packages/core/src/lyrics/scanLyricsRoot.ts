import type { FileAccess, FileRef } from '../file-access/types';
import { walkDirectory } from '../library-scan/walk';

const LRC_EXTENSION = '.lrc';

/**
 * Finds every .lrc file under a lyrics scope - the same recursive walk
 * scanRoot uses for a music root's audio/playlists, just filtered down to
 * sidecar lyrics files instead. A lyrics scope is a (rootId, relativePath)
 * pair rather than always a whole root of its own - see LyricsScope's doc -
 * so this accepts an optional startPath to walk from a subfolder of an
 * already-granted root instead of requiring a brand-new OS-level grant just
 * for lyrics. Returns FileRef so callers can feed the result straight into
 * findAutoLyricsMatch (fileId/name) or readFileText (to actually parse one
 * with parseLrc).
 *
 * KNOWN ISSUE (Windows): walkDirectory's listDirectory call into
 * FileAccessModule.h's native ListDirectory can fail with a bare WinRT
 * E_INVALIDARG ("The parameter is incorrect.") for a freshly-granted root.
 * Reproduced on a plain %TEMP% subfolder as well as a real library folder,
 * for both a lyrics scope and a plain music root added via "Add Folder" - so
 * it isn't lyrics-specific or junction/symlink-specific (no reparse points
 * in the %TEMP% repro's ancestry). Root cause not yet identified; needs
 * native-side (FileAccessModule.h) debugging on a real Windows box.
 */
export async function scanLyricsRoot(fileAccess: FileAccess, rootId: string, startPath?: string): Promise<FileRef[]> {
  const { files } = await walkDirectory(fileAccess, rootId, startPath);
  return files.filter((file) => file.name.toLowerCase().endsWith(LRC_EXTENSION));
}

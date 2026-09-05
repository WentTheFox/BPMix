import type { FileAccess, FileRef } from '../file-access/types';
import { walkDirectory } from '../library-scan/walk';

const LRC_EXTENSION = '.lrc';

/**
 * Finds every .lrc file under a lyrics root - the same recursive walk
 * scanRoot uses for a music root's audio/playlists, just filtered down to
 * sidecar lyrics files instead. Returns FileRef so callers can feed the
 * result straight into findAutoLyricsMatch (fileId/name) or readFileText
 * (to actually parse one with parseLrc).
 */
export async function scanLyricsRoot(fileAccess: FileAccess, rootId: string): Promise<FileRef[]> {
  const { files } = await walkDirectory(fileAccess, rootId);
  return files.filter((file) => file.name.toLowerCase().endsWith(LRC_EXTENSION));
}

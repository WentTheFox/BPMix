import type { FileAccess, FileRef } from '../file-access/types';

const PLAYLIST_EXTENSIONS = ['.m3u8', '.m3u'];

export interface WalkResult {
  /** Every file found under the root, playlists included. */
  files: FileRef[];
  playlistFiles: FileRef[];
}

function isPlaylistFile(name: string): boolean {
  const lower = name.toLowerCase();
  return PLAYLIST_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Recursively walks a granted root via repeated single-level listDirectory
 * calls, since that's the operation every platform's FileAccess adapter can
 * implement directly against its native directory APIs.
 */
export async function walkDirectory(fileAccess: FileAccess, rootId: string): Promise<WalkResult> {
  const files: FileRef[] = [];
  const playlistFiles: FileRef[] = [];

  async function recurse(relativePath?: string): Promise<void> {
    const entries = await fileAccess.listDirectory(rootId, relativePath);
    for (const entry of entries) {
      if (entry.type === 'file' && entry.file) {
        files.push(entry.file);
        if (isPlaylistFile(entry.file.name)) {
          playlistFiles.push(entry.file);
        }
      } else if (entry.type === 'directory') {
        await recurse(entry.relativePath);
      }
    }
  }

  await recurse();
  return { files, playlistFiles };
}

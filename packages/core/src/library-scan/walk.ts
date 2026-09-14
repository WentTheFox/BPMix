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
 * A dot-prefixed directory is always tooling's own bookkeeping, never
 * content a user actually curated - e.g. Syncthing's ".stversions" (old
 * revisions of synced files, kept around for conflict recovery) and
 * ".stfolder" (its per-folder marker), or a plain ".git". Recursing into
 * one wastes a whole listDirectory round-trip (a real HTTP request for the
 * self-hosted server adapter) per level for files that could never be
 * legitimate playlist entries anyway, and for Syncthing specifically could
 * mean scanning the same tracks' entire version history as if they were
 * real library content.
 */
function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Recursively walks a granted root via repeated single-level listDirectory
 * calls, since that's the operation every platform's FileAccess adapter can
 * implement directly against its native directory APIs. Sibling
 * subdirectories are recursed into concurrently rather than one at a time -
 * each listDirectory call is a full HTTP round-trip for the self-hosted
 * server adapter (fileAccess.server.ts), so a library with hundreds of
 * artist folders was previously hundreds of round-trips back to back; the
 * browser's File System Access API adapter benefits too, just less
 * dramatically since those calls don't cross the network. Result order is
 * no longer meaningful (it used to be depth-first-in-listing-order), but
 * nothing downstream (scanRoot builds a Map keyed by relativePath) relies
 * on it.
 */
export async function walkDirectory(fileAccess: FileAccess, rootId: string, startPath?: string): Promise<WalkResult> {
  const files: FileRef[] = [];
  const playlistFiles: FileRef[] = [];

  async function recurse(relativePath?: string): Promise<void> {
    const entries = await fileAccess.listDirectory(rootId, relativePath);
    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (entry.type === 'file' && entry.file) {
        files.push(entry.file);
        if (isPlaylistFile(entry.file.name)) {
          playlistFiles.push(entry.file);
        }
      } else if (entry.type === 'directory' && !isIgnoredDirectory(entry.name)) {
        subdirectories.push(entry.relativePath);
      }
    }
    await Promise.all(subdirectories.map((dir) => recurse(dir)));
  }

  // Undefined (not '') so a root-level scan's listDirectory(rootId, undefined)
  // call is identical to before this parameter existed - some adapters key
  // their root entry by undefined specifically (see fileAccess.android.ts's
  // dirUriByRoot cache), not by ''.
  await recurse(startPath || undefined);
  return { files, playlistFiles };
}

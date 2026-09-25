import type { FileAccess, FileRef } from '../file-access/types';

const PLAYLIST_EXTENSIONS = ['.m3u8', '.m3u'];

export interface WalkProgress {
  foldersListed: number;
  /** Every file seen so far, playlists and non-audio files included. */
  filesFound: number;
}

export interface WalkResult {
  /** Every file found under the root, playlists included. */
  files: FileRef[];
  playlistFiles: FileRef[];
}

/**
 * Thrown by walkDirectory/scanRoot when the caller's AbortSignal fires
 * mid-scan - a distinct class (rather than checking DOMException's name,
 * which not every platform's AbortController implementation sets the same
 * way) so callers can tell "the user cancelled this" apart from a real scan
 * failure without string-matching an error message.
 */
export class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled');
    this.name = 'ScanCancelledError';
  }
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
 * Upper bound on listDirectory calls in flight at once during a walk.
 * Walking siblings concurrently used to be unbounded, which on Windows
 * fired one WinRT storage-broker listing (each with its own batch of
 * GetBasicPropertiesAsync calls, see FileAccessModule.h's ListDirectory)
 * per artist folder all at once - a large library ballooned the app to
 * ~850 threads and the scan hung forever with zero I/O, stuck on
 * "Scanning folder...". A small cap keeps most of the concurrency win for
 * the self-hosted server adapter's HTTP round-trips without flooding any
 * platform's native directory API.
 */
const MAX_CONCURRENT_LISTINGS = 8;

function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter (active stays the same)
      // rather than releasing it and letting a new caller race for it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Recursively walks a granted root via repeated single-level listDirectory
 * calls, since that's the operation every platform's FileAccess adapter can
 * implement directly against its native directory APIs. Sibling
 * subdirectories are recursed into concurrently (up to
 * MAX_CONCURRENT_LISTINGS listings at once) rather than one at a time -
 * each listDirectory call is a full HTTP round-trip for the self-hosted
 * server adapter (fileAccess.server.ts), so a library with hundreds of
 * artist folders was previously hundreds of round-trips back to back; the
 * browser's File System Access API adapter benefits too, just less
 * dramatically since those calls don't cross the network. Result order is
 * no longer meaningful (it used to be depth-first-in-listing-order), but
 * nothing downstream (scanRoot builds a Map keyed by relativePath) relies
 * on it.
 *
 * `signal`, when given, is checked before each listDirectory call (not
 * mid-call - there's no way to abort a native listDirectory that's already
 * in flight, only to stop starting new ones) - see ScanCancelledError's doc.
 * A signal that's already aborted when this is first called throws
 * immediately, without ever calling listDirectory once.
 */
export async function walkDirectory(
  fileAccess: FileAccess,
  rootId: string,
  startPath?: string,
  signal?: AbortSignal,
  /** Called after every completed listing with running totals - there's no known total up front, a walk only discovers the tree as it goes. */
  onProgress?: (progress: WalkProgress) => void,
): Promise<WalkResult> {
  const files: FileRef[] = [];
  const playlistFiles: FileRef[] = [];
  // Only held around the listDirectory call itself, never across the
  // recursion below - holding it while awaiting children would deadlock
  // once the tree is deeper than MAX_CONCURRENT_LISTINGS.
  const limit = createLimiter(MAX_CONCURRENT_LISTINGS);
  let foldersListed = 0;

  async function recurse(relativePath?: string): Promise<void> {
    if (signal?.aborted) throw new ScanCancelledError();
    const entries = await limit(() => {
      // Re-checked here: a queued listing may only get its slot well after
      // the user cancelled.
      if (signal?.aborted) throw new ScanCancelledError();
      return fileAccess.listDirectory(rootId, relativePath);
    });
    if (signal?.aborted) throw new ScanCancelledError();
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
    foldersListed++;
    onProgress?.({ foldersListed, filesFound: files.length });
    await Promise.all(subdirectories.map((dir) => recurse(dir)));
  }

  // Undefined (not '') so a root-level scan's listDirectory(rootId, undefined)
  // call is identical to before this parameter existed - some adapters key
  // their root entry by undefined specifically (see fileAccess.android.ts's
  // dirUriByRoot cache), not by ''.
  await recurse(startPath || undefined);
  return { files, playlistFiles };
}

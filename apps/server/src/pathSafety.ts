import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Thrown when a requested relative path resolves outside its root directory. */
export class UnsafePathError extends Error {}

/**
 * Joins relativePath onto rootAbsolutePath and verifies (via realpath, so
 * symlinks can't be used to escape either) that the result is still inside
 * the root. Throws UnsafePathError otherwise. Both paths must already exist.
 */
export async function resolveSafePath(rootAbsolutePath: string, relativePath: string | undefined): Promise<string> {
  const joined = path.join(rootAbsolutePath, relativePath ?? '');
  let realRoot: string;
  let realJoined: string;
  try {
    [realRoot, realJoined] = await Promise.all([realpath(rootAbsolutePath), realpath(joined)]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const notFound = new Error(`Path "${relativePath}" not found`) as Error & { status?: number };
      notFound.status = 404;
      throw notFound;
    }
    throw err;
  }
  if (realJoined !== realRoot && !realJoined.startsWith(realRoot + path.sep)) {
    throw new UnsafePathError(`Path "${relativePath}" escapes its root`);
  }
  return realJoined;
}

/**
 * Like resolveSafePath, but for a target file that doesn't need to exist
 * yet (writeFileText's create-or-overwrite contract - a new playlist, or a
 * relocated entry rewritten into an existing one). Only relativePath's
 * PARENT directory has to already exist: that's the part resolved (and
 * symlink-checked) via resolveSafePath, same as any read. The final path
 * segment is validated separately (rejecting empty/"."/".." - a bare
 * path.posix.basename doesn't rule out a lone ".." segment on its own)
 * and joined back on afterward, which can't escape parentDir since it's
 * used as a single literal segment, never re-split on "/".
 */
export async function resolveSafeWritePath(rootAbsolutePath: string, relativePath: string): Promise<string> {
  const dir = path.posix.dirname(relativePath);
  const fileName = path.posix.basename(relativePath);
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new UnsafePathError(`Invalid file name in "${relativePath}"`);
  }
  const parentDir = await resolveSafePath(rootAbsolutePath, dir === '.' ? undefined : dir);
  return path.join(parentDir, fileName);
}

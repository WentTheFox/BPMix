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

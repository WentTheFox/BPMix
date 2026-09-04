import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface DiscoveredRoot {
  id: string;
  displayName: string;
  absolutePath: string;
}

/**
 * Each top-level subdirectory of baseDir becomes a library root, so mounting
 * a volume at e.g. /music/MyLibrary is enough to expose it - no config file
 * or env var per root needed. Re-scanned per request rather than cached, since
 * a self-hosted library is small and volumes can be added/removed at runtime.
 */
export async function discoverRoots(baseDir: string): Promise<DiscoveredRoot[]> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      displayName: entry.name,
      absolutePath: path.join(baseDir, entry.name),
    }));
}

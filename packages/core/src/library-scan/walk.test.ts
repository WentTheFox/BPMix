import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess } from '../file-access/types';
import { walkDirectory } from './walk';

/**
 * A FileAccess whose only real method is listDirectory, over a set of file
 * paths - each call takes a macrotask to resolve so concurrent calls
 * actually overlap, and tracks the most calls ever in flight at once.
 */
function createTrackingFileAccess(paths: string[]) {
  const stats = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const listDirectory = async (_rootId: string, relativePath = ''): Promise<DirectoryEntry[]> => {
    stats.calls++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    stats.inFlight--;

    const prefix = relativePath === '' ? '' : `${relativePath}/`;
    const seen = new Set<string>();
    const entries: DirectoryEntry[] = [];
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const [child, ...rest] = path.slice(prefix.length).split('/');
      if (!child || seen.has(child)) continue;
      seen.add(child);
      const childPath = prefix + child;
      entries.push(
        rest.length === 0
          ? {
              type: 'file',
              name: child,
              relativePath: childPath,
              file: { id: childPath, name: child, relativePath: childPath, sizeBytes: 1, lastModifiedMs: 0 },
            }
          : { type: 'directory', name: child, relativePath: childPath },
      );
    }
    return entries;
  };
  return { fileAccess: { listDirectory } as unknown as FileAccess, stats };
}

describe('walkDirectory', () => {
  it('caps concurrent listDirectory calls for a wide library instead of listing every folder at once', async () => {
    // 200 artist folders x 3 albums each - previously 200, then 600,
    // listings all in flight at the same moment.
    const paths: string[] = [];
    for (let artist = 0; artist < 200; artist++) {
      for (let album = 0; album < 3; album++) {
        paths.push(`Artist ${artist}/Album ${album}/01.mp3`);
      }
    }
    const { fileAccess, stats } = createTrackingFileAccess(paths);

    const { files } = await walkDirectory(fileAccess, 'root-1');

    expect(files).toHaveLength(600);
    expect(stats.calls).toBe(1 + 200 + 600);
    expect(stats.maxInFlight).toBeGreaterThan(1);
    expect(stats.maxInFlight).toBeLessThanOrEqual(8);
  });

  it('finishes a tree deeper than the concurrency cap (slots are never held across recursion)', async () => {
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/');
    const { fileAccess } = createTrackingFileAccess([`${deep}/track.mp3`, 'top.mp3']);

    const { files } = await walkDirectory(fileAccess, 'root-1');

    expect(files.map((f) => f.name).sort()).toEqual(['top.mp3', 'track.mp3']);
  });
});

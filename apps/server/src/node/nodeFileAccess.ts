import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';
import { discoverRoots } from '../rootDiscovery.js';
import { resolveSafePath, resolveSafeWritePath } from '../pathSafety.js';

/** Same id shape the HTTP file routes use, so a FileRef is interchangeable between the two. */
export function toFileRef(rootId: string, relativePath: string, name: string, sizeBytes: number, lastModifiedMs: number): FileRef {
  return { id: `${rootId}:${relativePath}`, name, relativePath, sizeBytes, lastModifiedMs };
}

export type NodeFileAccess = FileAccess & {
  /** The file's real path on disk (symlink-checked), for handing to ffmpeg and the like. */
  absolutePathOf(ref: FileRef): Promise<string>;
};

/**
 * FileAccess over the server's own disk, so the scan/metadata/lyrics code in
 * @bpmix/core runs unchanged on the server. Roots come from the volume
 * mounts under baseDir (see discoverRoots), never from a user prompt, hence
 * requestRoot/revokeRoot are not supported.
 */
export function createNodeFileAccess(baseDir: string, lyricsRootIds: ReadonlySet<string> = new Set()): NodeFileAccess {
  async function rootPath(rootId: string): Promise<string> {
    const root = (await discoverRoots(baseDir, lyricsRootIds)).find((r) => r.id === rootId);
    if (!root) throw new Error(`No library root "${rootId}"`);
    return root.absolutePath;
  }

  async function absolutePathOf(ref: FileRef): Promise<string> {
    const rootId = ref.id.slice(0, ref.id.length - ref.relativePath.length - 1);
    return resolveSafePath(await rootPath(rootId), ref.relativePath);
  }

  return {
    absolutePathOf,

    async requestRoot() {
      throw new Error('Server roots are defined by volume mounts, not requested');
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      const roots = await discoverRoots(baseDir, lyricsRootIds);
      return roots.map((r) => ({ id: r.id, displayName: r.displayName, kind: r.kind, removable: false }));
    },

    async revokeRoot() {
      throw new Error('Server roots are defined by volume mounts, not revoked');
    },

    async listDirectory(rootId, relativePath) {
      const dirPath = await resolveSafePath(await rootPath(rootId), relativePath);
      const prefix = relativePath ? `${relativePath}/` : '';
      const children = await readdir(dirPath, { withFileTypes: true });
      return Promise.all(
        children.map(async (child): Promise<DirectoryEntry> => {
          const childRelativePath = prefix + child.name;
          if (child.isDirectory()) {
            return { type: 'directory', name: child.name, relativePath: childRelativePath };
          }
          const st = await stat(path.join(dirPath, child.name));
          return {
            type: 'file',
            name: child.name,
            relativePath: childRelativePath,
            file: toFileRef(rootId, childRelativePath, child.name, st.size, st.mtimeMs),
          };
        }),
      );
    },

    async readFileBytes(ref) {
      const buf = await readFile(await absolutePathOf(ref));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },

    async readFileText(ref) {
      return readFile(await absolutePathOf(ref), 'utf8');
    },

    // sha256 of the local copy; only ever compared against an earlier value
    // from this same adapter (see TrackMetadata.contentHash).
    async getContentHash(ref) {
      const hash = createHash('sha256');
      await pipeline(createReadStream(await absolutePathOf(ref)), hash);
      return hash.digest('hex');
    },

    async writeFileText(rootId, relativePath, contents) {
      await writeFile(await resolveSafeWritePath(await rootPath(rootId), relativePath), contents, 'utf8');
    },
  };
}

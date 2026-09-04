import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';

/**
 * Talks to apps/server's /api/roots endpoints, which expose directories
 * mounted into the container as Docker volumes. Roots are operator-granted
 * (via the volume mount itself), not user-granted, so requestRoot/revokeRoot
 * are no-ops here - see fileAccess.composite.ts for how that's surfaced.
 */
export function createServerFileAccess(): FileAccess {
  async function listRoots(): Promise<GrantedRoot[]> {
    const res = await fetch('/api/roots');
    if (!res.ok) {
      throw new Error(`Failed to list server library roots: ${res.status}`);
    }
    return res.json();
  }

  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      return null;
    },

    listGrantedRoots: listRoots,

    async revokeRoot(): Promise<void> {
      // Server roots come from an operator-mounted volume; there's nothing
      // client-side to revoke.
    },

    async listDirectory(rootId: string, relativePath?: string): Promise<DirectoryEntry[]> {
      const params = new URLSearchParams();
      if (relativePath) params.set('path', relativePath);
      const res = await fetch(`/api/roots/${encodeURIComponent(rootId)}/entries?${params}`);
      if (!res.ok) {
        throw new Error(`Failed to list directory "${relativePath ?? ''}": ${res.status}`);
      }
      return res.json();
    },

    async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
      const [rootId] = ref.id.split(':');
      const params = new URLSearchParams({ path: ref.relativePath });
      const res = await fetch(`/api/roots/${encodeURIComponent(rootId!)}/file?${params}`);
      if (!res.ok) {
        throw new Error(`Failed to read "${ref.relativePath}": ${res.status}`);
      }
      return res.arrayBuffer();
    },

    async readFileText(ref: FileRef): Promise<string> {
      const [rootId] = ref.id.split(':');
      const params = new URLSearchParams({ path: ref.relativePath });
      const res = await fetch(`/api/roots/${encodeURIComponent(rootId!)}/text?${params}`);
      if (!res.ok) {
        throw new Error(`Failed to read "${ref.relativePath}": ${res.status}`);
      }
      return res.text();
    },
  };
}

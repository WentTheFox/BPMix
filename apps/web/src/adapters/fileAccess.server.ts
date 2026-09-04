import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';

/** Each "/"-separated segment must be encoded on its own - encoding the whole path would turn its "/"s into %2F. */
function encodeRelativePath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function fileUrl(rootId: string, relativePath: string): string {
  return `/library/${encodeURIComponent(rootId)}/${encodeRelativePath(relativePath)}`;
}

/**
 * Talks to apps/server's /api/roots endpoints, which expose directories
 * mounted into the container as Docker volumes, plus its /library static
 * mount for the actual file bytes (see index.ts for why that's a plain
 * express.static instead of a proxied route). Roots are operator-granted
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
      const res = await fetch(fileUrl(rootId!, ref.relativePath));
      if (!res.ok) {
        throw new Error(`Failed to read "${ref.relativePath}": ${res.status}`);
      }
      return res.arrayBuffer();
    },

    async readFileText(ref: FileRef): Promise<string> {
      const [rootId] = ref.id.split(':');
      const res = await fetch(fileUrl(rootId!, ref.relativePath));
      if (!res.ok) {
        throw new Error(`Failed to read "${ref.relativePath}": ${res.status}`);
      }
      return res.text();
    },
  };
}

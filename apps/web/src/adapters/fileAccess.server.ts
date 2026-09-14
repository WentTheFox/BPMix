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

    getStreamUrl(ref: FileRef): string {
      const [rootId] = ref.id.split(':');
      // Absolute (scheme + origin), not relative - jsmediatags' bundled
      // XhrFileReader only recognizes a location as URL-fetchable when it
      // matches `scheme://...` (see readTagsFromUrl's doc); a bare
      // "/library/..." path would instead be treated as an in-memory byte
      // array location and fail.
      return new URL(fileUrl(rootId!, ref.relativePath), window.location.origin).toString();
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

    async writeFileText(): Promise<void> {
      // apps/server exposes no write endpoint yet - see CLAUDE.md's
      // housekeeping TODO. Throwing a clear, specific error here (rather
      // than a generic fetch 404/405) lets the UI show a real message
      // instead of a confusing failure.
      throw new Error('Creating a playlist on a self-hosted server root is not supported yet.');
    },
  };
}

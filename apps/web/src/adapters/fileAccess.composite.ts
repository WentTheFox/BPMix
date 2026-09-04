import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';
import { createFileAccess } from './fileAccess';
import { createServerFileAccess } from './fileAccess.server';

// Composite root/file ids are `${scheme}::${innerId}` so operations route to
// the right backend. "::" (not ":') to keep collisions with relativePath
// segments - which may legitimately contain a single ":" on some filesystems -
// vanishingly unlikely; this is a display/routing detail, not a security boundary.
const LOCAL = 'local';
const SERVER = 'server';

function encode(scheme: string, innerId: string): string {
  return `${scheme}::${innerId}`;
}

function decode(compositeId: string): { scheme: string; innerId: string } {
  const sep = compositeId.indexOf('::');
  if (sep === -1) {
    throw new Error(`Malformed composite id "${compositeId}"`);
  }
  return { scheme: compositeId.slice(0, sep), innerId: compositeId.slice(sep + 2) };
}

function rewriteEntry(scheme: string, entry: DirectoryEntry): DirectoryEntry {
  if (entry.type !== 'file' || !entry.file) return entry;
  return { ...entry, file: rewriteFileRef(scheme, entry.file) };
}

function rewriteFileRef(scheme: string, file: FileRef): FileRef {
  const [innerRootId] = file.id.split(':');
  return { ...file, id: encode(scheme, `${innerRootId}:${file.relativePath}`) };
}

/**
 * Merges the browser's File System Access API roots (folders the user picked
 * on this device) with any roots apps/server exposes from a mounted Docker
 * volume. Server roots need no per-session consent - the operator already
 * granted access by mounting the volume - so they're just listed, never
 * "requested". If apps/server isn't present (e.g. a static-only deploy with
 * no backend, like Cloudflare Pages), the server probe fails once and this
 * behaves exactly like the plain browser adapter from then on.
 */
export function createCompositeFileAccess(): FileAccess {
  const browser = createFileAccess();
  const server = createServerFileAccess();
  let serverAvailable: boolean | undefined;

  async function isServerAvailable(): Promise<boolean> {
    if (serverAvailable !== undefined) return serverAvailable;
    try {
      await server.listGrantedRoots();
      serverAvailable = true;
    } catch {
      serverAvailable = false;
    }
    return serverAvailable;
  }

  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      const root = await browser.requestRoot();
      return root ? { ...root, id: encode(LOCAL, root.id) } : null;
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      const [localRoots, serverRoots] = await Promise.all([
        browser.listGrantedRoots(),
        isServerAvailable().then((available) => (available ? server.listGrantedRoots() : [])),
      ]);
      return [
        ...localRoots.map((r) => ({ ...r, id: encode(LOCAL, r.id) })),
        ...serverRoots.map((r) => ({ ...r, id: encode(SERVER, r.id) })),
      ];
    },

    async revokeRoot(rootId: string): Promise<void> {
      const { scheme, innerId } = decode(rootId);
      if (scheme === LOCAL) {
        await browser.revokeRoot(innerId);
      }
      // Server roots are operator-configured (mounted volumes), not
      // user-granted - nothing to revoke client-side.
    },

    async listDirectory(rootId: string, relativePath?: string): Promise<DirectoryEntry[]> {
      const { scheme, innerId } = decode(rootId);
      const adapter = scheme === SERVER ? server : browser;
      const entries = await adapter.listDirectory(innerId, relativePath);
      return entries.map((entry) => rewriteEntry(scheme, entry));
    },

    async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
      const { scheme, innerId } = decode(ref.id);
      const [innerRootId] = innerId.split(':');
      const adapter = scheme === SERVER ? server : browser;
      return adapter.readFileBytes({ ...ref, id: innerRootId! });
    },

    async readFileText(ref: FileRef): Promise<string> {
      const { scheme, innerId } = decode(ref.id);
      const [innerRootId] = innerId.split(':');
      const adapter = scheme === SERVER ? server : browser;
      return adapter.readFileText({ ...ref, id: innerRootId! });
    },
  };
}

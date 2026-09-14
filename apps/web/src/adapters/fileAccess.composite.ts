import type { DirectoryEntry, FileAccess, FileAccessCallOptions, FileRef, GrantedRoot } from '@bpmix/core';
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
// Module-level (not per-createCompositeFileAccess-call) since App.tsx only
// ever constructs one composite adapter as a singleton anyway, and
// isServerBackendAvailable below needs to share this same cached result
// rather than re-probing the server itself.
let serverAvailable: boolean | undefined;

/**
 * Whether apps/server is actually backing this deployment (a real mounted-
 * volume Docker self-host) as opposed to a static-only deploy with no
 * backend - used to skip the "install this app" onboarding prompt (see
 * App.tsx), since server-granted roots need no browser permission at all,
 * so there's nothing for installing as a PWA to help with in that mode.
 */
export async function isServerBackendAvailable(): Promise<boolean> {
  if (serverAvailable !== undefined) return serverAvailable;
  try {
    await createServerFileAccess().listGrantedRoots();
    serverAvailable = true;
  } catch {
    serverAvailable = false;
  }
  return serverAvailable;
}

/**
 * True for a root id this composite adapter issued for a server-backed
 * root (an operator-mounted Docker volume, exposed via fileAccess.server.ts)
 * as opposed to a browser-granted local folder. Used by App.tsx's refresh()
 * to always rescan server roots rather than trusting the cached track list -
 * see that call site's doc for why server roots specifically get this
 * treatment.
 */
export function isServerRootId(rootId: string): boolean {
  return decode(rootId).scheme === SERVER;
}

export function createCompositeFileAccess(): FileAccess {
  const browser = createFileAccess();
  const server = createServerFileAccess();

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
    async requestRoot(kind?: 'library' | 'lyrics'): Promise<GrantedRoot | null> {
      const root = await browser.requestRoot(kind);
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

    async listDirectory(rootId: string, relativePath?: string, opts?: FileAccessCallOptions): Promise<DirectoryEntry[]> {
      const { scheme, innerId } = decode(rootId);
      const adapter = scheme === SERVER ? server : browser;
      const entries = await adapter.listDirectory(innerId, relativePath, opts);
      return entries.map((entry) => rewriteEntry(scheme, entry));
    },

    async readFileBytes(ref: FileRef, opts?: FileAccessCallOptions): Promise<ArrayBuffer> {
      const { scheme, innerId } = decode(ref.id);
      const [innerRootId] = innerId.split(':');
      const adapter = scheme === SERVER ? server : browser;
      return adapter.readFileBytes({ ...ref, id: innerRootId! }, opts);
    },

    async readFileText(ref: FileRef, opts?: FileAccessCallOptions): Promise<string> {
      const { scheme, innerId } = decode(ref.id);
      const [innerRootId] = innerId.split(':');
      const adapter = scheme === SERVER ? server : browser;
      return adapter.readFileText({ ...ref, id: innerRootId! }, opts);
    },

    // Only server-backed refs have an HTTP URL to give - the browser
    // adapter reads local disk via the File System Access API, with
    // nothing to route a ranged fetch through. Omitting this for local
    // refs (rather than returning something unusable) is what makes
    // ensureTrackMetadata's `getStreamUrl?.(ref)` check correctly fall
    // back to a full readFileBytes for those.
    getStreamUrl(ref: FileRef): string | undefined {
      const { scheme, innerId } = decode(ref.id);
      if (scheme !== SERVER) return undefined;
      const [innerRootId] = innerId.split(':');
      return server.getStreamUrl!({ ...ref, id: innerRootId! });
    },

    async writeFileText(rootId: string, relativePath: string, contents: string): Promise<void> {
      const { scheme, innerId } = decode(rootId);
      const adapter = scheme === SERVER ? server : browser;
      return adapter.writeFileText(innerId, relativePath, contents);
    },
  };
}

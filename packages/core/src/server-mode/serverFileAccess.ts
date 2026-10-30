import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import type { ServerMode } from './serverMode';

/** Thrown by operations that only make sense with local folders (granting a folder, editing an .m3u8 in place, ...). */
export class ServerModeUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} isn't available while the library comes from a server`);
    this.name = 'ServerModeUnsupportedError';
  }
}

/**
 * FileAccess over the server's library. The library itself arrives through the sync, so this only
 * has to name the roots (from the last sync, no network) and hand over a track's audio on request.
 */
function createServerFileAccess(serverMode: ServerMode): FileAccess {
  const api = () => {
    const client = serverMode.getApi();
    if (!client) throw new ServerModeUnsupportedError('Reading files without a server connection');
    return client;
  };
  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      throw new ServerModeUnsupportedError('Adding a folder');
    },
    async listGrantedRoots(): Promise<GrantedRoot[]> {
      return serverMode.roots();
    },
    async revokeRoot(): Promise<void> {
      throw new ServerModeUnsupportedError('Removing a folder');
    },
    async listDirectory(): Promise<DirectoryEntry[]> {
      return [];
    },
    async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
      const client = api();
      return client.fetchBytes(client.streamPathForFileId(ref.id));
    },
    async readFileText(): Promise<string> {
      throw new ServerModeUnsupportedError('Reading lyrics files');
    },
    async writeFileText(): Promise<void> {
      throw new ServerModeUnsupportedError('Editing playlist files');
    },
  };
}

/**
 * The FileAccess the app uses: local folders normally, the server's library once signed in. Decided
 * per call, so signing in or out takes effect immediately without rebuilding anything.
 */
export function createModeAwareFileAccess(local: FileAccess, serverMode: ServerMode): FileAccess {
  const server = createServerFileAccess(serverMode);
  const pick = () => (serverMode.isActive() ? server : local);
  return {
    requestRoot: (kind) => pick().requestRoot(kind),
    listGrantedRoots: () => pick().listGrantedRoots(),
    revokeRoot: (rootId) => pick().revokeRoot(rootId),
    listDirectory: (rootId, relativePath, opts) => pick().listDirectory(rootId, relativePath, opts),
    readFileBytes: (ref, opts) => pick().readFileBytes(ref, opts),
    readFileText: (ref, opts) => pick().readFileText(ref, opts),
    writeFileText: (rootId, relativePath, contents) => pick().writeFileText(rootId, relativePath, contents),
    // Only meaningful for local folders (and the legacy web server): metadata comes from the sync in server mode.
    getStreamUrl: (ref) => (serverMode.isActive() ? undefined : local.getStreamUrl?.(ref)),
    getContentHash: async (ref) => (serverMode.isActive() ? null : ((await local.getContentHash?.(ref)) ?? null)),
  };
}

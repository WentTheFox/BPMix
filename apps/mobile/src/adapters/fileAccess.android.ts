import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';
import {
  getPersistedUriPermissions,
  listFiles,
  openDocumentTree,
  readFile,
  releasePersistableUriPermission,
} from 'react-native-scoped-storage';
import { base64ToArrayBuffer } from './base64';

function displayNameFromTreeUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const lastSegment = decoded.split('/').pop() ?? decoded;
  const colonIndex = lastSegment.lastIndexOf(':');
  return (colonIndex === -1 ? lastSegment : lastSegment.slice(colonIndex + 1)) || lastSegment;
}

/**
 * relativePath -> content:// uri, per root. SAF tree uris don't encode a
 * navigable path, so listDirectory needs to remember the uri a previous
 * listing handed back for a given relativePath in order to list *into* it.
 * A fresh walk (initial scan / startup / manual rescan) always lists a
 * directory before recursing into it, so this is populated by the time a
 * deeper relativePath is requested.
 */
const dirUriByRoot = new Map<string, Map<string, string>>();

function cacheFor(rootId: string): Map<string, string> {
  let cache = dirUriByRoot.get(rootId);
  if (!cache) {
    cache = new Map();
    dirUriByRoot.set(rootId, cache);
  }
  return cache;
}

export function createFileAccess(): FileAccess {
  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      const result = await openDocumentTree(true);
      if (!result) {
        return null;
      }
      cacheFor(result.uri).set('', result.uri);
      return { id: result.uri, displayName: result.name || displayNameFromTreeUri(result.uri) };
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      const uris = await getPersistedUriPermissions();
      return uris.map((uri) => {
        cacheFor(uri).set('', uri);
        return { id: uri, displayName: displayNameFromTreeUri(uri) };
      });
    },

    async revokeRoot(rootId: string): Promise<void> {
      await releasePersistableUriPermission(rootId);
      dirUriByRoot.delete(rootId);
    },

    async listDirectory(rootId: string, relativePath = ''): Promise<DirectoryEntry[]> {
      const cache = cacheFor(rootId);
      if (!cache.has('')) {
        cache.set('', rootId);
      }
      const dirUri = cache.get(relativePath);
      if (!dirUri) {
        throw new Error(
          `Unknown directory "${relativePath}" under root ${rootId} - it must be listed via its parent first.`,
        );
      }

      const children = await listFiles(dirUri);
      const prefix = relativePath ? `${relativePath}/` : '';
      const entries: DirectoryEntry[] = [];

      for (const child of children) {
        const childRelativePath = prefix + child.name;
        cache.set(childRelativePath, child.uri);

        if (child.type === 'directory') {
          entries.push({ type: 'directory', name: child.name, relativePath: childRelativePath });
        } else {
          const fileRef: FileRef = {
            id: child.uri,
            name: child.name,
            relativePath: childRelativePath,
            // listFiles doesn't return a size, and stat()-ing every file during
            // a scan of a large library is too slow over the bridge to do
            // eagerly; lastModified alone drives the rescan change-detection
            // this feeds.
            sizeBytes: 0,
            lastModifiedMs: child.lastModified,
          };
          entries.push({ type: 'file', name: child.name, relativePath: childRelativePath, file: fileRef });
        }
      }
      return entries;
    },

    async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
      const base64 = await readFile(ref.id, 'base64');
      return base64ToArrayBuffer(base64);
    },

    async readFileText(ref: FileRef): Promise<string> {
      return readFile(ref.id, 'utf8');
    },
  };
}

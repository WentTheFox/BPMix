import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';
import { idbDelete, idbGet, idbGetAll, idbPut, openDb } from './indexedDb';

interface StoredRoot {
  id: string;
  displayName: string;
  handle: FileSystemDirectoryHandle;
}

const DB_NAME = 'bpmix-file-access';
const DB_VERSION = 1;
const STORE_NAME = 'roots';

function getDb(): Promise<IDBDatabase> {
  return openDb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  });
}

async function resolveDirectoryHandle(
  root: FileSystemDirectoryHandle,
  relativePath: string | undefined,
): Promise<FileSystemDirectoryHandle> {
  if (!relativePath) {
    return root;
  }
  let current = root;
  for (const part of relativePath.split('/').filter(Boolean)) {
    current = await current.getDirectoryHandle(part);
  }
  return current;
}

function toFileRef(rootId: string, relativePath: string, file: File): FileRef {
  return {
    id: `${rootId}:${relativePath}`,
    name: file.name,
    relativePath,
    sizeBytes: file.size,
    lastModifiedMs: file.lastModified,
  };
}

async function getRootOrThrow(db: IDBDatabase, rootId: string): Promise<StoredRoot> {
  const root = await idbGet<StoredRoot>(db, STORE_NAME, rootId);
  if (!root) {
    throw new Error(`No granted root with id "${rootId}" - it may have been revoked.`);
  }
  const permission = await root.handle.queryPermission({ mode: 'read' });
  if (permission !== 'granted') {
    const requested = await root.handle.requestPermission({ mode: 'read' });
    if (requested !== 'granted') {
      throw new Error(`Read permission for "${root.displayName}" was not granted - reconnect it from the library screen.`);
    }
  }
  return root;
}

export function createFileAccess(): FileAccess {
  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await window.showDirectoryPicker({ mode: 'read' });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return null;
        }
        throw err;
      }

      const db = await getDb();
      const id = crypto.randomUUID();
      const stored: StoredRoot = { id, displayName: handle.name, handle };
      await idbPut(db, STORE_NAME, stored);
      return { id, displayName: stored.displayName };
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      const db = await getDb();
      const roots = await idbGetAll<StoredRoot>(db, STORE_NAME);
      return roots.map((r) => ({ id: r.id, displayName: r.displayName }));
    },

    async revokeRoot(rootId: string): Promise<void> {
      const db = await getDb();
      await idbDelete(db, STORE_NAME, rootId);
    },

    async listDirectory(rootId: string, relativePath?: string): Promise<DirectoryEntry[]> {
      const db = await getDb();
      const root = await getRootOrThrow(db, rootId);
      const dirHandle = await resolveDirectoryHandle(root.handle, relativePath);

      const entries: DirectoryEntry[] = [];
      const prefix = relativePath ? `${relativePath}/` : '';
      for await (const [name, childHandle] of dirHandle.entries()) {
        const childRelativePath = prefix + name;
        if (childHandle.kind === 'file') {
          const file = await childHandle.getFile();
          entries.push({
            type: 'file',
            name,
            relativePath: childRelativePath,
            file: toFileRef(rootId, childRelativePath, file),
          });
        } else {
          entries.push({ type: 'directory', name, relativePath: childRelativePath });
        }
      }
      return entries;
    },

    async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
      const [rootId] = ref.id.split(':');
      const db = await getDb();
      const root = await getRootOrThrow(db, rootId!);
      const dir = await resolveDirectoryHandle(root.handle, ref.relativePath.split('/').slice(0, -1).join('/'));
      const fileHandle = await dir.getFileHandle(ref.name);
      const file = await fileHandle.getFile();
      return file.arrayBuffer();
    },

    async readFileText(ref: FileRef): Promise<string> {
      const [rootId] = ref.id.split(':');
      const db = await getDb();
      const root = await getRootOrThrow(db, rootId!);
      const dir = await resolveDirectoryHandle(root.handle, ref.relativePath.split('/').slice(0, -1).join('/'));
      const fileHandle = await dir.getFileHandle(ref.name);
      const file = await fileHandle.getFile();
      return file.text();
    },
  };
}

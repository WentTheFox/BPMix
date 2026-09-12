import { FileAccessPermissionPendingError, type DirectoryEntry, type FileAccess, type FileAccessCallOptions, type FileRef, type GrantedRoot } from '@bpmix/core';
import { idbDelete, idbGet, idbGetAll, idbPut, openDb } from './indexedDb';

interface StoredRoot {
  id: string;
  displayName: string;
  handle: FileSystemDirectoryHandle;
  /** Absent on roots stored before this field existed - listGrantedRoots() defaults those to 'library', same as GrantedRoot.kind's own doc. */
  kind?: 'library' | 'lyrics';
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

/**
 * `mode` defaults to 'read' for every existing call site. 'readwrite' is
 * used only by writeFileText - a separate, stronger permission the File
 * System Access API tracks independently per handle, not implied by an
 * existing 'read' grant. Requesting it lazily (only when a write is
 * actually attempted) rather than requesting 'readwrite' up front in
 * requestRoot() keeps every other root's grant at the narrower 'read'
 * scope it's had since before writeFileText existed.
 */
async function getRootOrThrow(db: IDBDatabase, rootId: string, allowPrompt: boolean, mode: 'read' | 'readwrite' = 'read'): Promise<StoredRoot> {
  const root = await idbGet<StoredRoot>(db, STORE_NAME, rootId);
  if (!root) {
    throw new Error(`No granted root with id "${rootId}" - it may have been revoked.`);
  }
  const permission = await root.handle.queryPermission({ mode });
  if (permission !== 'granted') {
    // requestPermission() only succeeds when called synchronously off a
    // real user gesture - calling it from background/idle-scheduled code
    // (see createBackgroundFileAccess) always throws a SecurityError, so
    // this must never attempt it for such a call. Surfacing a typed error
    // instead lets a background pass (matchLibraryLyrics,
    // ensureLyricsAssignment) catch it and skip quietly rather than crash.
    // writeFileText is never called from such a pass (playlist creation is
    // always a deliberate, foreground user action), but this guard stays
    // shared regardless.
    if (!allowPrompt) {
      throw new FileAccessPermissionPendingError(root.displayName);
    }
    const requested = await root.handle.requestPermission({ mode });
    if (requested !== 'granted') {
      const verb = mode === 'readwrite' ? 'Write' : 'Read';
      throw new Error(`${verb} permission for "${root.displayName}" was not granted - reconnect it from the library screen.`);
    }
  }
  return root;
}

export function createFileAccess(): FileAccess {
  return {
    async requestRoot(kind: 'library' | 'lyrics' = 'library'): Promise<GrantedRoot | null> {
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
      const stored: StoredRoot = { id, displayName: handle.name, handle, kind };
      await idbPut(db, STORE_NAME, stored);
      return { id, displayName: stored.displayName, kind };
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      const db = await getDb();
      const roots = await idbGetAll<StoredRoot>(db, STORE_NAME);
      return roots.map((r) => ({ id: r.id, displayName: r.displayName, kind: r.kind ?? 'library' }));
    },

    async revokeRoot(rootId: string): Promise<void> {
      const db = await getDb();
      await idbDelete(db, STORE_NAME, rootId);
    },

    async listDirectory(rootId: string, relativePath?: string, opts?: FileAccessCallOptions): Promise<DirectoryEntry[]> {
      const db = await getDb();
      const root = await getRootOrThrow(db, rootId, opts?.allowPrompt ?? true);
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

    async readFileBytes(ref: FileRef, opts?: FileAccessCallOptions): Promise<ArrayBuffer> {
      const [rootId] = ref.id.split(':');
      const db = await getDb();
      const root = await getRootOrThrow(db, rootId!, opts?.allowPrompt ?? true);
      const dir = await resolveDirectoryHandle(root.handle, ref.relativePath.split('/').slice(0, -1).join('/'));
      const fileHandle = await dir.getFileHandle(ref.name);
      const file = await fileHandle.getFile();
      return file.arrayBuffer();
    },

    async readFileText(ref: FileRef, opts?: FileAccessCallOptions): Promise<string> {
      const [rootId] = ref.id.split(':');
      const db = await getDb();
      const root = await getRootOrThrow(db, rootId!, opts?.allowPrompt ?? true);
      const dir = await resolveDirectoryHandle(root.handle, ref.relativePath.split('/').slice(0, -1).join('/'));
      const fileHandle = await dir.getFileHandle(ref.name);
      const file = await fileHandle.getFile();
      return file.text();
    },

    async writeFileText(rootId: string, relativePath: string, contents: string): Promise<void> {
      const db = await getDb();
      // Always allowPrompt: true - creating a playlist is always a
      // deliberate, foreground user action (never a background pass), so
      // there's no FileAccessCallOptions parameter to thread through here.
      const root = await getRootOrThrow(db, rootId, true, 'readwrite');
      const segments = relativePath.split('/');
      const name = segments.pop()!;
      const dir = await resolveDirectoryHandle(root.handle, segments.join('/'));
      const fileHandle = await dir.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
    },
  };
}

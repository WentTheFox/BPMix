/** Minimal promise wrapper around the parts of IndexedDB the adapters need. */

// Every store/fileAccess call used to call openDb() fresh (a real
// indexedDB.open() round-trip every time) - each libraryStore.ts/fileAccess.ts
// call (getCoverArt, getMetadata, getLyricsAssignment, readFileText, etc.)
// paid that cost separately, which measured at 20-140ms per open during the
// early burst of calls at app/library-list mount (dozens of rows each firing
// a handful of these), and still ~0.1-0.3ms apiece once warmed - trivial
// individually, but adding up to real, measurable jank across a few hundred
// calls (confirmed live via [PERF] timing - see loadAssignedLyrics/
// useCoverArt instrumentation). A connection is cheap to hold open and safe
// to share (IndexedDB transactions are already serialized per store), so
// this caches the resolved connection per db name instead of reopening it -
// only re-opening if the cached connection was closed (e.g. by the
// onversionchange handler below, when another tab needs a version bump).
const openConnections = new Map<string, Promise<IDBDatabase>>();

export function openDb(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const cached = openConnections.get(name);
  if (cached) return cached;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      // Without this, a stale connection in another tab blocks that tab's
      // own open() (or a version bump/reset) forever with no error - this
      // lets this connection yield instead of hanging the other tab.
      db.onversionchange = () => {
        db.close();
        openConnections.delete(name);
      };
      resolve(db);
    };
    request.onerror = () => {
      openConnections.delete(name);
      reject(request.error);
    };
    // Fires when this open() can't proceed because another tab still holds
    // an open connection (e.g. to a version this reset/upgrade invalidated).
    // Without a handler here the promise never settles - "hangs forever"
    // with no error - instead of surfacing the actual problem.
    request.onblocked = () => {
      openConnections.delete(name);
      reject(new Error(`IndexedDB "${name}" open blocked - close other tabs with this site open and retry`));
    };
  });
  openConnections.set(name, promise);
  return promise;
}

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function idbGet<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const tx = db.transaction(storeName, 'readonly');
  return wrapRequest(tx.objectStore(storeName).get(key));
}

export function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  return wrapRequest(tx.objectStore(storeName).getAll());
}

/** `key` is only needed for a store with no keyPath (its value isn't an object carrying its own key field). */
export function idbPut(db: IDBDatabase, storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function idbDelete(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

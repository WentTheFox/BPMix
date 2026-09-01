/** Minimal promise wrapper around the parts of IndexedDB the adapters need. */

export function openDb(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      // Without this, a stale connection in another tab blocks that tab's
      // own open() (or a version bump/reset) forever with no error - this
      // lets this connection yield instead of hanging the other tab.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // Fires when this open() can't proceed because another tab still holds
    // an open connection (e.g. to a version this reset/upgrade invalidated).
    // Without a handler here the promise never settles - "hangs forever"
    // with no error - instead of surfacing the actual problem.
    request.onblocked = () =>
      reject(new Error(`IndexedDB "${name}" open blocked - close other tabs with this site open and retry`));
  });
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

export function idbPut(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
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

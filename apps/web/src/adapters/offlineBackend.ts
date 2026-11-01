import { ApiError, NetworkError, type OfflineBackend } from '@beatseam/core';

const DIRECTORY = 'beatseam-offline';
const MANIFEST = 'manifest.json';

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (data: ArrayBuffer | Uint8Array) => toHex(await crypto.subtle.digest('SHA-256', data as BufferSource));

/** Whether this browser can hold downloaded audio in its private file system. */
export function supportsOfflineStorage(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' && typeof crypto?.subtle?.digest === 'function';
}

/**
 * Downloaded audio in the Origin Private File System (OPFS): no permission prompts, not visible to the
 * person as files, and a file only appears once fully written (a writable stream commits on close).
 * File names are the SHA-256 of the track id - ids are long paths with characters a file name can't
 * hold - and a small manifest maps them back for list().
 */
export function createOfflineBackend(): OfflineBackend {
  let directory: Promise<FileSystemDirectoryHandle> | null = null;
  let manifest: Promise<Map<string, { fileId: string; sizeBytes: number }>> | null = null;
  let saving: Promise<void> = Promise.resolve();
  let askedForPersistence = false;

  const getDirectory = () => (directory ??= navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(DIRECTORY, { create: true })));

  const getManifest = () =>
    (manifest ??= (async () => {
      const dir = await getDirectory();
      try {
        const text = await (await (await dir.getFileHandle(MANIFEST)).getFile()).text();
        return new Map(Object.entries(JSON.parse(text) as Record<string, { fileId: string; sizeBytes: number }>));
      } catch {
        return new Map();
      }
    })());

  /** Serialised, so two saves can't interleave. */
  const saveManifest = (): Promise<void> => {
    saving = saving.then(async () => {
      const [dir, entries] = await Promise.all([getDirectory(), getManifest()]);
      const writable = await (await dir.getFileHandle(MANIFEST, { create: true })).createWritable();
      await writable.write(JSON.stringify(Object.fromEntries(entries)));
      await writable.close();
    });
    return saving;
  };

  const nameFor = (fileId: string) => sha256Hex(new TextEncoder().encode(fileId));

  return {
    async download({ fileId, url, headers, signal, onProgress }) {
      // Ask the browser not to evict this storage under pressure (silent in Chromium; may prompt elsewhere).
      if (!askedForPersistence) {
        askedForPersistence = true;
        void navigator.storage.persist?.().catch(() => undefined);
      }
      let response: Response;
      try {
        response = await fetch(url, { headers, signal });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new NetworkError(err);
      }
      if (!response.ok) throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);

      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          onProgress?.(received);
        }
      } catch (err) {
        if (signal.aborted) throw err;
        throw new NetworkError(err);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const sha256 = await sha256Hex(bytes);

      const [dir, entries, name] = await Promise.all([getDirectory(), getManifest(), nameFor(fileId)]);
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(bytes);
      await writable.close(); // the file only appears (or changes) here, complete
      entries.set(name, { fileId, sizeBytes: received });
      await saveManifest();
      return { sizeBytes: received, sha256 };
    },

    async read(fileId) {
      try {
        const dir = await getDirectory();
        return await (await (await dir.getFileHandle(await nameFor(fileId))).getFile()).arrayBuffer();
      } catch {
        return null;
      }
    },

    async remove(fileId) {
      const [dir, entries, name] = await Promise.all([getDirectory(), getManifest(), nameFor(fileId)]);
      await dir.removeEntry(name).catch(() => undefined);
      if (entries.delete(name)) await saveManifest();
    },

    async list() {
      const [dir, entries] = await Promise.all([getDirectory(), getManifest()]);
      const present: { fileId: string; sizeBytes: number }[] = [];
      for (const [name, entry] of entries) {
        const exists = await dir.getFileHandle(name).then(() => true, () => false);
        if (exists) present.push(entry);
      }
      return present;
    },
  };
}

import { ApiError, NetworkError, type OfflineBackend } from '@beatseam/core';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { base64ToArrayBuffer } from './base64';

interface NativeOffline {
  offlineDownload(requestId: string, fileId: string, url: string, headers: Record<string, string>): Promise<{ sizeBytes: number; sha256: string }>;
  offlineCancel(requestId: string): void;
  offlineReadBase64(fileId: string): Promise<string | null>;
  offlineSize(fileId: string): Promise<number>;
  offlineRemove(fileId: string): Promise<void>;
  readLocalText(fileName: string): Promise<string | null>;
  writeLocalText(fileName: string, content: string): Promise<void>;
}

const native = NativeModules.BeatseamFileAccess as NativeOffline;
const MANIFEST = 'offline-manifest.json';

/** Downloaded audio is plain files in the app's private storage; always available on Android. */
export function supportsOfflineStorage(): boolean {
  return true;
}

/**
 * Downloaded audio under the app's private files dir. The transfer and the SHA-256 happen natively
 * (BeatseamFileAccessModule.kt's offlineDownload) so the bytes never cross the JS bridge on the way in.
 * Files are named after a hash of the track id natively; a small manifest maps ids to sizes for list().
 */
export function createOfflineBackend(): OfflineBackend {
  const events = new NativeEventEmitter(NativeModules.BeatseamFileAccess);
  let nextRequest = 0;
  let manifest: Promise<Record<string, number>> | null = null;
  let saving: Promise<void> = Promise.resolve();

  const getManifest = () =>
    (manifest ??= native.readLocalText(MANIFEST).then((text) => {
      try {
        return text ? (JSON.parse(text) as Record<string, number>) : {};
      } catch {
        return {};
      }
    }));

  /** Serialised, so two saves can't interleave. */
  const saveManifest = (): Promise<void> => {
    saving = saving.then(async () => native.writeLocalText(MANIFEST, JSON.stringify(await getManifest())));
    return saving;
  };

  return {
    async download({ fileId, url, headers, signal, onProgress }) {
      if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const requestId = String(++nextRequest);
      const subscription = events.addListener('BeatseamOfflineProgress', (event: { requestId: string; bytes: number }) => {
        if (event.requestId === requestId) onProgress?.(event.bytes);
      });
      const onAbort = () => native.offlineCancel(requestId);
      signal.addEventListener('abort', onAbort);
      try {
        const result = await native.offlineDownload(requestId, fileId, url, headers);
        (await getManifest())[fileId] = result.sizeBytes;
        await saveManifest();
        return result;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (code === 'ABORTED' || signal.aborted) throw err;
        const status = /^HTTP_(\d+)$/.exec(code)?.[1];
        if (status) throw new ApiError(Number(status), `HTTP ${status}`);
        throw new NetworkError(err);
      } finally {
        signal.removeEventListener('abort', onAbort);
        subscription.remove();
      }
    },

    async read(fileId) {
      const base64 = await native.offlineReadBase64(fileId);
      return base64 === null ? null : base64ToArrayBuffer(base64);
    },

    async remove(fileId) {
      await native.offlineRemove(fileId);
      const entries = await getManifest();
      if (fileId in entries) {
        delete entries[fileId];
        await saveManifest();
      }
    },

    async list() {
      const entries = await getManifest();
      const present: { fileId: string; sizeBytes: number }[] = [];
      for (const fileId of Object.keys(entries)) {
        const sizeBytes = await native.offlineSize(fileId);
        if (sizeBytes >= 0) present.push({ fileId, sizeBytes });
      }
      return present;
    },
  };
}

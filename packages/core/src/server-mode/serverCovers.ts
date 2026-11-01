import { ApiError, encodeTrackKey, NetworkError } from '@beatseam/api';
import type { LibraryStore } from '../library-store/types';
import type { ServerMode } from './serverMode';

/**
 * Wraps a LibraryStore so cover art is fetched from the server the first time something asks for it,
 * then kept like any other cover. The sync deliberately doesn't download art up front: a library has
 * thousands of tracks and the screen only ever shows a few dozen.
 */
export function withServerCoverArt(store: LibraryStore, serverMode: ServerMode): LibraryStore {
  const inFlight = new Map<string, Promise<string | null>>();
  const confirmedNone = new Set<string>();

  const fetchCover = async (fileId: string): Promise<string | null> => {
    const api = serverMode.getApi();
    if (!api || confirmedNone.has(fileId)) return null;
    try {
      const { bytes, contentType } = await api.fetchFile(api.coverPath(encodeTrackKey(fileId)));
      await store.putCoverArt(fileId, { mimeType: contentType.split(';')[0]!.trim(), data: new Uint8Array(bytes) });
      return await store.getCoverArt(fileId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) confirmedNone.add(fileId); // a track with no art: don't ask again this session
      else if (!(err instanceof NetworkError)) throw err;
      return null; // offline: not remembered, so it's tried again next time
    }
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getCoverArt') {
        return async (fileId: string): Promise<string | null> => {
          const stored = await target.getCoverArt(fileId);
          if (stored !== null || !serverMode.isActive()) return stored;
          let pending = inFlight.get(fileId);
          if (!pending) {
            pending = fetchCover(fileId).finally(() => inFlight.delete(fileId));
            inFlight.set(fileId, pending);
          }
          return pending;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

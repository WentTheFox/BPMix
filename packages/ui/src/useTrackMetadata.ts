import type { LibraryStore, TrackMetadata } from '@bpmix/core';
import { useEffect, useState } from 'react';

const METADATA_RETRY_MS = 500;

/**
 * Fetches a track's metadata (title/artist/album), retrying on a short
 * interval until it resolves - same shape as useTrackAnalysis, and for the
 * same reason: the background metadata scan (see scanLibraryMetadata)
 * writes results asynchronously, so the row backing this hook can easily
 * mount before its file's turn in the scan queue.
 */
export function useTrackMetadata(libraryStore: LibraryStore, fileId: string | null): TrackMetadata | null {
  const [metadata, setMetadata] = useState<TrackMetadata | null>(null);
  useEffect(() => {
    setMetadata(null);
    if (!fileId) return;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    const tryFetch = () => {
      libraryStore.getMetadata(fileId).then((result) => {
        if (cancelled) return;
        if (result) {
          setMetadata(result);
        } else {
          retryTimeout = setTimeout(tryFetch, METADATA_RETRY_MS);
        }
      });
    };
    tryFetch();
    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [libraryStore, fileId]);
  return metadata;
}

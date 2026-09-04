import { isMetadataCurrent, type LibraryStore, type TrackMetadata } from '@bpmix/core';
import { useEffect, useState } from 'react';

const METADATA_RETRY_MS = 500;

/**
 * Fetches a track's metadata (title/artist/album), retrying on a short
 * interval until it resolves - same shape as useTrackAnalysis, and for the
 * same reason: the background metadata scan (see scanLibraryMetadata)
 * writes results asynchronously, so the row backing this hook can easily
 * mount before its file's turn in the scan queue.
 *
 * Keeps retrying even after finding a result if it's from an older
 * parserVersion (still displayed immediately, so title/artist don't
 * regress to the filename while this happens) - a library that already
 * had metadata from before some field was added (e.g. cover art) will
 * have exactly that stale-but-non-null data sitting in the store the
 * moment this mounts, well before the background rescan reaches that
 * track and actually backfills the new field. Without this, callers that
 * gate other lazy fetches on "metadata is present" (see useCoverArt) would
 * fire that fetch against the pre-rescan state and never retry.
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
        }
        if (!isMetadataCurrent(result)) {
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

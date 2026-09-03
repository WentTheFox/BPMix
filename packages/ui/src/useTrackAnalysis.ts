import type { AnalysisResult, LibraryStore } from '@bpmix/core';
import { useEffect, useState } from 'react';

const ANALYSIS_RETRY_MS = 500;

/**
 * Fetches a track's analysis, retrying on a short interval until it
 * resolves. Just-in-time analysis computes it asynchronously right after a
 * track is decoded - the very first fetch immediately after selecting a
 * track can easily land before that write actually completes, and a
 * one-shot fetch would then show nothing for that track's whole session,
 * since nothing else ever triggers a refetch once analysis does finish.
 */
export function useTrackAnalysis(libraryStore: LibraryStore, fileId: string | null): AnalysisResult | null {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  useEffect(() => {
    setAnalysis(null);
    if (!fileId) return;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    const tryFetch = () => {
      libraryStore.getAnalysis(fileId).then((result) => {
        if (cancelled) return;
        if (result) {
          setAnalysis(result);
        } else {
          retryTimeout = setTimeout(tryFetch, ANALYSIS_RETRY_MS);
        }
      });
    };
    tryFetch();
    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [libraryStore, fileId]);
  return analysis;
}

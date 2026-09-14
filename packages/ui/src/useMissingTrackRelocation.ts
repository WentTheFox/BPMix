import {
  errorMessage,
  isAudioFileName,
  logLibraryAction,
  relocateMissingTrack,
  walkDirectory,
  type FileAccess,
  type FileRef,
  type TrackRecord,
} from '@bpmix/core';
import { useCallback, useState } from 'react';

export interface MissingTrackTarget {
  track: TrackRecord;
  rootId: string;
}

export interface MissingTrackRelocationInput {
  fileAccess: FileAccess;
  /** Re-reads the root's playlists/tracks after a successful relocate, so the placeholder turns back into a real, playable TrackRecord. */
  rescan: (rootId: string) => Promise<void>;
  setError: (err: string | null) => void;
}

export interface MissingTrackRelocation {
  /** Non-null while the "why is this greyed out" explanation dialog should show - see explainMissingTrack. */
  explainTarget: MissingTrackTarget | null;
  /** Non-null while the locate-file screen should show. */
  locateTarget: MissingTrackTarget | null;
  /** Every audio-looking file found in locateTarget's root - null while still walking it. */
  candidates: FileRef[] | null;
  /** True between picking a candidate and the m3u8 rewrite (+ rescan) actually landing. */
  relocating: boolean;
  /** Call from a TrackRow's onPress when the pressed track is missing, instead of trying to play it. */
  explainMissingTrack: (track: TrackRecord, rootId: string) => void;
  cancelExplain: () => void;
  /** Moves from the explain dialog into the locate-file screen and starts walking the root for candidates. */
  beginLocate: () => void;
  cancelLocate: () => void;
  selectCandidate: (file: FileRef) => Promise<void>;
}

/**
 * Shared behavior behind a missing playlist entry's "why is this greyed
 * out" explanation and its "locate this file" follow-up - identical between
 * apps/mobile and apps/web/src/App.tsx (same state machine: explain -> pick
 * a candidate -> rewrite every playlist referencing the old path -> rescan),
 * so it lives here rather than as two copies that only look similar today
 * (see CLAUDE.md's note on why that's worth doing proactively, same
 * reasoning as useLibraryRootActions).
 */
export function useMissingTrackRelocation({ fileAccess, rescan, setError }: MissingTrackRelocationInput): MissingTrackRelocation {
  const [explainTarget, setExplainTarget] = useState<MissingTrackTarget | null>(null);
  const [locateTarget, setLocateTarget] = useState<MissingTrackTarget | null>(null);
  const [candidates, setCandidates] = useState<FileRef[] | null>(null);
  const [relocating, setRelocating] = useState(false);

  const explainMissingTrack = useCallback((track: TrackRecord, rootId: string) => setExplainTarget({ track, rootId }), []);
  const cancelExplain = useCallback(() => setExplainTarget(null), []);

  const beginLocate = useCallback(() => {
    if (!explainTarget) return;
    const target = explainTarget;
    setLocateTarget(target);
    setExplainTarget(null);
    setCandidates(null);
    void walkDirectory(fileAccess, target.rootId)
      .then(({ files }) => setCandidates(files.filter((f) => isAudioFileName(f.name))))
      .catch((err) => {
        setError(errorMessage(err));
        logLibraryAction('locateMissingTrack:scanFailed', { rootId: target.rootId, error: String(err) });
      });
  }, [explainTarget, fileAccess, setError]);

  const cancelLocate = useCallback(() => {
    setLocateTarget(null);
    setCandidates(null);
  }, []);

  const selectCandidate = useCallback(
    async (file: FileRef) => {
      if (!locateTarget) return;
      setRelocating(true);
      try {
        await relocateMissingTrack(fileAccess, locateTarget.rootId, locateTarget.track.relativePath, file.relativePath);
        logLibraryAction('relocateMissingTrack', { rootId: locateTarget.rootId, from: locateTarget.track.relativePath, to: file.relativePath });
        setLocateTarget(null);
        setCandidates(null);
        await rescan(locateTarget.rootId);
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('relocateMissingTrack:failed', { error: String(err) });
      } finally {
        setRelocating(false);
      }
    },
    [locateTarget, fileAccess, rescan, setError],
  );

  return { explainTarget, locateTarget, candidates, relocating, explainMissingTrack, cancelExplain, beginLocate, cancelLocate, selectCandidate };
}

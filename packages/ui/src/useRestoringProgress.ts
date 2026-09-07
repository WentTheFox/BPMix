import { useCallback, useState } from 'react';
import type { RestoringStepKey } from './restoringSteps';

export interface RestoringProgress {
  completedSteps: Set<RestoringStepKey>;
  currentStep: RestoringStepKey | null;
  /** Whether at least one lyrics scope is configured - RestoringScreen only shows the "Scanning lyrics" row when this is true, so a user with no lyrics folders doesn't see a row that can never complete. */
  hasLyricsScopes: boolean;
  /** Marks the previously-current step (if any) complete and makes `step` the new current step. */
  advanceStep: (step: RestoringStepKey) => void;
  setHasLyricsScopes: (hasLyricsScopes: boolean) => void;
}

/**
 * Shared by both apps' App.tsx (passed into refresh() and
 * usePlaybackPersistence's onStepChange) to drive RestoringScreen's
 * checklist - kept here rather than duplicated per app so the
 * mark-previous-complete bookkeeping can't drift between them.
 */
export function useRestoringProgress(): RestoringProgress {
  const [completedSteps, setCompletedSteps] = useState<Set<RestoringStepKey>>(() => new Set());
  const [currentStep, setCurrentStep] = useState<RestoringStepKey | null>(null);
  const [hasLyricsScopes, setHasLyricsScopes] = useState(false);

  const advanceStep = useCallback((step: RestoringStepKey) => {
    setCurrentStep((prev) => {
      if (prev) setCompletedSteps((completed) => (completed.has(prev) ? completed : new Set(completed).add(prev)));
      return step;
    });
  }, []);

  return { completedSteps, currentStep, hasLyricsScopes, advanceStep, setHasLyricsScopes };
}

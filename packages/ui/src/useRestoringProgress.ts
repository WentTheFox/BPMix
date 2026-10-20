import { selectCompletedSteps } from '@bpmix/core';
import type { RestoringStepKey } from '@bpmix/core';
import { useAppSelector } from './store/hooks';

export interface RestoringProgress {
  completedSteps: ReadonlySet<RestoringStepKey>;
  currentStep: RestoringStepKey | null;
  /** Whether at least one lyrics scope is configured - RestoringScreen only shows the "Scanning lyrics" row when this is true, so a user with no lyrics folders doesn't see a row that can never complete. */
  hasLyricsScopes: boolean;
}

/**
 * The startup checklist RestoringScreen shows, read from the store's
 * `restore` slice - advanced by restorePlayback and refreshLibrary as they
 * work through their phases.
 */
export function useRestoringProgress(): RestoringProgress {
  const completedSteps = useAppSelector(selectCompletedSteps);
  const currentStep = useAppSelector((state) => state.restore.currentStep);
  const hasLyricsScopes = useAppSelector((state) => state.restore.hasLyricsScopes);
  return { completedSteps, currentStep, hasLyricsScopes };
}

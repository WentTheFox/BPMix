export type SyncInputModality = 'touch' | 'keyboard';

export interface SyncKeyboardActions {
  mark: () => void;
  back: () => void;
  break: () => void;
  skip: () => void;
  seek: (deltaSeconds: number) => void;
}

/**
 * Native (Android/iOS/Windows) has no mouse/keyboard input to distinguish
 * from touch the way a browser does - always 'touch', and no arrow-key
 * wiring. See useLyricsSyncInputModality.web.ts for the real
 * touch/mouse/keyboard detection and the actual keydown handling, used on
 * the web build only.
 */
export function useLyricsSyncInputModality(_actions: SyncKeyboardActions, _disabled: boolean): SyncInputModality {
  return 'touch';
}

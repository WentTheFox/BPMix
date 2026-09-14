import type { AppUpdateNativeBridge } from '@bpmix/core';

/**
 * No APK/install-package concept on Windows (updates there would mean an
 * MSIX sideload flow, a different mechanism entirely - not implemented).
 * Returning null (rather than a bridge that throws) lets App.tsx pass
 * `appUpdate: undefined` to SettingsScreen, which omits the whole "Updates"
 * row instead of showing a button that can't do anything - see
 * AppUpdateNativeBridge's doc.
 */
export function createAppUpdateBridge(): AppUpdateNativeBridge | null {
  return null;
}

import type { OfflineBackend } from '@bpmix/core';

/** Windows has no native downloader yet (see the Server mode TODO in CLAUDE.md), so there is no offline storage there. */
export function supportsOfflineStorage(): boolean {
  return false;
}

export function createOfflineBackend(): OfflineBackend {
  throw new Error('Offline downloads are not supported on Windows yet');
}

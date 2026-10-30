import type { BackgroundTicks } from '@bpmix/core';

/** Windows' timers keep running in the background; nothing to add. */
export function createBackgroundTicks(): BackgroundTicks | undefined {
  return undefined;
}

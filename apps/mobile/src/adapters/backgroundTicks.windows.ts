import type { BackgroundTicks } from '@beatseam/core';

/** Windows' timers keep running in the background; nothing to add. */
export function createBackgroundTicks(): BackgroundTicks | undefined {
  return undefined;
}

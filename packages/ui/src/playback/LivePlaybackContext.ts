import { createContext, useContext } from 'react';
import type { LivePlayback } from '@bpmix/core';

/** Carries the app's LivePlayback so any component can subscribe to the fast-moving player state without it being threaded through props from the root. */
export const LivePlaybackContext = createContext<LivePlayback | null>(null);

export const LivePlaybackProvider = LivePlaybackContext.Provider;

export function useLivePlayback(): LivePlayback {
  const live = useContext(LivePlaybackContext);
  if (!live) throw new Error('useLivePlayback needs a <LivePlaybackProvider> above it');
  return live;
}

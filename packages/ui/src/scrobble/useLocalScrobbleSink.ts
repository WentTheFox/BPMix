import { createLocalScrobbleSink, type ScrobbleSink } from '@bpmix/core';
import { useMemo } from 'react';
import type { AppSettings } from '../settings/types';

/** The sink for scrobbling straight to Last.fm with this device's own session, or null while that isn't connected. */
export function useLocalScrobbleSink(settings: AppSettings): ScrobbleSink | null {
  const { lastFmApiKey, lastFmApiSecret, lastFmSessionKey } = settings;
  return useMemo(
    () => (lastFmSessionKey && lastFmApiKey && lastFmApiSecret ? createLocalScrobbleSink({ apiKey: lastFmApiKey, apiSecret: lastFmApiSecret }, lastFmSessionKey) : null),
    [lastFmApiKey, lastFmApiSecret, lastFmSessionKey],
  );
}

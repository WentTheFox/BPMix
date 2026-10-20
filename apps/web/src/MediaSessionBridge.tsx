import { useFastDisplay } from '@bpmix/ui';
import { useMediaSessionNotification } from './adapters/mediaSessionNotification';
import type { MediaSessionNotificationCallbacks, MediaSessionNotificationInfo } from './adapters/mediaSessionNotification';

export interface MediaSessionBridgeProps {
  /** Null when nothing has actually played this session. The live position/duration are filled in here. */
  info: Omit<MediaSessionNotificationInfo, 'positionSeconds' | 'durationSeconds'> | null;
  callbacks: MediaSessionNotificationCallbacks;
  crossfadeSeconds: number;
}

/**
 * Feeds the browser media session the live position. Headless: it exists so
 * the per-tick position subscription re-renders only this (renderless)
 * component, not the app root that owns everything else. See
 * apps/mobile/src/MediaSessionBridge.tsx for the native counterpart.
 */
export function MediaSessionBridge({ info, callbacks, crossfadeSeconds }: MediaSessionBridgeProps) {
  const { displayPositionSeconds, displayDurationSeconds } = useFastDisplay(crossfadeSeconds);
  useMediaSessionNotification(info ? { ...info, positionSeconds: displayPositionSeconds, durationSeconds: displayDurationSeconds } : null, callbacks);
  return null;
}

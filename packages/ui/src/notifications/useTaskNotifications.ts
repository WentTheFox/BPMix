import { syncTaskNotifications } from '@bpmix/core';
import { useEffect } from 'react';
import { useAppDispatch } from '../store/hooks';

/**
 * Mirrors @bpmix/core's shared task queue into the notification list for as
 * long as the calling component is mounted - see syncTaskNotifications for
 * the rules (queued/paused markers, "done" lingering, same-id dedup).
 */
export function useTaskNotifications(): void {
  const dispatch = useAppDispatch();
  useEffect(() => syncTaskNotifications(dispatch), [dispatch]);
}

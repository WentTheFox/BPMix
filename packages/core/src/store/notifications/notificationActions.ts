/**
 * Callbacks for notification rows' secondary actions (e.g. "Cancel" on a
 * running scan), keyed by notification id. Functions aren't serializable, so
 * the notifications slice only keeps the label; the thunks in
 * notificationsThunks.ts keep this registry in step with the slice.
 */
const actions = new Map<string, () => void>();

export function setNotificationAction(id: string, onPress: (() => void) | undefined): void {
  if (onPress) actions.set(id, onPress);
  else actions.delete(id);
}

export function runNotificationAction(id: string): void {
  actions.get(id)?.();
}

export function clearNotificationActions(): void {
  actions.clear();
}

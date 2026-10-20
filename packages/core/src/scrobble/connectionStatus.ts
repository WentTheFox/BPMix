/** A Last.fm connect attempt that's in flight. 'idle' = no attempt running, so the resting status applies. */
export type LastFmAttemptStatus = 'idle' | 'requestingToken' | 'awaitingAuthorization' | 'confirming';

export type LastFmConnectionStatus = 'disconnected' | 'requestingToken' | 'awaitingAuthorization' | 'confirming' | 'connected';

/**
 * What the Settings UI should show. An attempt in flight wins; otherwise
 * it's derived from whether a session key is stored.
 *
 * Derived rather than held in state because settings hydrate from storage
 * AFTER the connection hook first mounts: a status initialised once from the
 * session key at mount always read 'disconnected' after a restart, showing
 * the Connect form for an account that was in fact still connected (and
 * pressing Connect overwrote the working session).
 */
export function deriveLastFmStatus(attempt: LastFmAttemptStatus, sessionKey: string | null): LastFmConnectionStatus {
  if (attempt !== 'idle') return attempt;
  return sessionKey ? 'connected' : 'disconnected';
}

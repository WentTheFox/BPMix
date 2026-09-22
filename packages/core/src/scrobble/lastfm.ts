import { md5 } from './md5';

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

/**
 * BPMix's own registered Last.fm API application (last.fm/api/account/create)
 * - shared across every install rather than making each person register
 * their own app, the same way GNOME's own Last.fm integration
 * (gnome-online-accounts, used by GNOME Music) ships one baked-in
 * credential for every user rather than a per-user app registration, and
 * Clementine (src/internet/lastfm/lastfmservice.cpp) does the same. The
 * app-level api_key/secret pair only identifies the app for request
 * signing - it never grants access to any specific person's account
 * without that person separately logging into their own Last.fm session
 * and approving BPMix there (see useLastFmConnection's auth flow), so
 * sharing one across installs doesn't expose any individual user's data.
 * A self-hoster/fork who'd rather use their own app identity can still
 * override both via Settings' "Use your own Last.fm API app" fields
 * (ExternalConnectionsScreen).
 */
export const DEFAULT_LASTFM_API_KEY = 'f56d82f8fe857197c4c2d1bd4d3fba49';
export const DEFAULT_LASTFM_API_SECRET = 'cc0e42388b8a8232cab10e13e828c982';

/** Last.fm scrobbling rule: a track under this length is never eligible, regardless of how much of it played. */
export const MIN_SCROBBLE_TRACK_SECONDS = 30;
/** Last.fm scrobbling rule: scrobble once playback reaches this fraction of the track's duration... */
export const SCROBBLE_THRESHOLD_FRACTION = 0.5;
/** ...or this many seconds in, whichever comes first. */
export const SCROBBLE_THRESHOLD_MAX_SECONDS = 4 * 60;

export class LastFmError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = 'LastFmError';
  }
}

export interface LastFmCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface LastFmSession {
  sessionKey: string;
  username: string;
}

export interface ScrobbleEntry {
  artist: string;
  track: string;
  /** Unix seconds the track STARTED playing - not "now" - per Last.fm's track.scrobble timestamp semantics. */
  timestamp: number;
  album: string | null;
  durationSeconds: number | null;
}

/**
 * Params sorted and concatenated per Last.fm's signing scheme (`format` and
 * `callback` excluded, everything else included) with the shared secret
 * appended, then MD5'd - see
 * https://www.last.fm/api/authspec#8 for the exact algorithm this
 * reproduces.
 */
function buildApiSig(params: Record<string, string>, apiSecret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort();
  const concatenated = keys.map((k) => `${k}${params[k]}`).join('');
  return md5(concatenated + apiSecret);
}

async function callApi(
  method: 'GET' | 'POST',
  params: Record<string, string>,
  credentials: LastFmCredentials,
  sign: boolean,
): Promise<Record<string, unknown>> {
  const fullParams: Record<string, string> = { ...params, api_key: credentials.apiKey };
  if (sign) fullParams.api_sig = buildApiSig(fullParams, credentials.apiSecret);
  fullParams.format = 'json';

  const body = new URLSearchParams(fullParams);
  const response = await fetch(method === 'GET' ? `${API_ROOT}?${body.toString()}` : API_ROOT, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'POST' ? body.toString() : undefined,
  });

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof json.error === 'number') {
    throw new LastFmError(typeof json.message === 'string' ? json.message : 'Last.fm API error', json.error);
  }
  if (!response.ok) throw new LastFmError(`Last.fm API request failed (HTTP ${response.status})`, null);
  return json;
}

/** Step 1 of the desktop auth flow: an unauthenticated token to send the user to authorize in a browser. */
export async function getAuthToken(credentials: LastFmCredentials): Promise<string> {
  const json = await callApi('GET', { method: 'auth.getToken' }, credentials, true);
  const token = (json.token as string | undefined) ?? null;
  if (!token) throw new LastFmError('Last.fm did not return an auth token', null);
  return token;
}

/** The page to open so the user can approve `token` - no callback URL needed for this desktop-style flow; the caller re-polls getSession once the user says they've approved. */
export function buildAuthUrl(credentials: LastFmCredentials, token: string): string {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(credentials.apiKey)}&token=${encodeURIComponent(token)}`;
}

/**
 * Last.fm's "web application" auth variant: no auth.getToken call up front -
 * Last.fm mints the token itself and redirects the browser to
 * `callbackUrl?token=...` once the user approves, which the caller reads
 * back automatically (a same-origin popup message on web, a `bpmix://`
 * deep link on Android) instead of the desktop flow's manual "I've approved
 * it" confirmation. Unlike most OAuth providers, Last.fm doesn't require
 * `cb` to be pre-registered - any URL works at request time, which is what
 * makes this usable from an arbitrary self-hosted BPMix origin.
 */
export function buildWebAuthUrl(credentials: LastFmCredentials, callbackUrl: string): string {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(credentials.apiKey)}&cb=${encodeURIComponent(callbackUrl)}`;
}

/**
 * Step 2: exchange an approved token for a permanent session key. Throws
 * LastFmError with code 14 ("Unauthorized Token") if the user hasn't
 * actually approved it in the browser yet - callers should surface that as
 * "not yet - try again after approving" rather than a hard failure.
 */
export async function getSession(credentials: LastFmCredentials, token: string): Promise<LastFmSession> {
  const json = await callApi('GET', { method: 'auth.getSession', token }, credentials, true);
  const session = json.session as { key?: string; name?: string } | undefined;
  if (!session?.key || !session.name) throw new LastFmError('Last.fm did not return a session', null);
  return { sessionKey: session.key, username: session.name };
}

/** Fire on track start - Last.fm surfaces this as the user's real-time "now playing" status, separate from the eventual scrobble. */
export async function updateNowPlaying(
  credentials: LastFmCredentials,
  sessionKey: string,
  entry: { artist: string; track: string; album: string | null; durationSeconds: number | null },
): Promise<void> {
  const params: Record<string, string> = { method: 'track.updateNowPlaying', sk: sessionKey, artist: entry.artist, track: entry.track };
  if (entry.album) params.album = entry.album;
  if (entry.durationSeconds) params.duration = String(Math.round(entry.durationSeconds));
  await callApi('POST', params, credentials, true);
}

/** Whether a played track/position qualifies for scrobbling per Last.fm's own rule (see the exported threshold constants). */
export function meetsScrobbleThreshold(durationSeconds: number, elapsedSeconds: number): boolean {
  if (durationSeconds < MIN_SCROBBLE_TRACK_SECONDS) return false;
  return elapsedSeconds >= Math.min(durationSeconds * SCROBBLE_THRESHOLD_FRACTION, SCROBBLE_THRESHOLD_MAX_SECONDS);
}

/**
 * Submits up to 50 scrobbles in one call (Last.fm's batch form: artist[0],
 * track[0], timestamp[0]... rather than repeated single calls) - used both
 * for a normal single-track scrobble and for flushing ScrobbleQueue's
 * offline backlog.
 */
export async function scrobbleBatch(credentials: LastFmCredentials, sessionKey: string, entries: ScrobbleEntry[]): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length > 50) throw new LastFmError('scrobbleBatch supports at most 50 entries per call', null);

  const params: Record<string, string> = { method: 'track.scrobble', sk: sessionKey };
  entries.forEach((entry, i) => {
    params[`artist[${i}]`] = entry.artist;
    params[`track[${i}]`] = entry.track;
    params[`timestamp[${i}]`] = String(entry.timestamp);
    if (entry.album) params[`album[${i}]`] = entry.album;
    if (entry.durationSeconds) params[`duration[${i}]`] = String(Math.round(entry.durationSeconds));
  });
  await callApi('POST', params, credentials, true);
}

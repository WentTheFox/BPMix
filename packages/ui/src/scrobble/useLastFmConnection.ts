import { buildAuthUrl, buildWebAuthUrl, getAuthToken, getSession, LastFmError } from '@bpmix/core';
import type { LastFmCredentials } from '@bpmix/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import type { AppSettings } from '../settings/types';

export type LastFmConnectionStatus = 'disconnected' | 'requestingToken' | 'awaitingAuthorization' | 'confirming' | 'connected';

/**
 * A verified Android App Link (AndroidManifest.xml's autoVerify intent-
 * filter + /.well-known/assetlinks.json served from this same domain) -
 * Last.fm's redirect after approval opens straight back into BPMix with no
 * "which app?" prompt, same as the bpmix:// scheme used to, but backed by a
 * real HTTPS URL that still resolves to a real page (apps/web/public/
 * lastfm-callback.html) if verification hasn't gone through on a given
 * device yet, rather than a dead link.
 */
const ANDROID_CALLBACK_URL = 'https://bpmix.went.tf/lastfm-callback.html';
/** The bpmix:// scheme's intent-filter (still there for the launcher shortcuts - see AndroidManifest.xml) also still matches this, kept only as a legacy fallback in case an in-flight auth attempt started before this switched to ANDROID_CALLBACK_URL above. */
const ANDROID_LEGACY_CALLBACK_URL = 'bpmix://lastfm-callback';

export interface UseLastFmConnectionResult {
  status: LastFmConnectionStatus;
  /** The Last.fm username lastFmSessionKey authenticates as, once connected. */
  username: string | null;
  errorMessage: string | null;
  /**
   * True when this platform's flow can't detect approval on its own and
   * needs the user to come back and press confirmAuthorized() - Windows
   * only (no protocol-handler registration yet to receive a callback). Web
   * (see useLastFmConnection.web.ts - a popup + postMessage) and Android
   * (the verified App Link below) complete automatically as soon as the
   * user approves in the browser; ExternalConnectionsScreen uses this to
   * decide whether to show the confirm button at all.
   */
  needsManualConfirmation: boolean;
  /** Starts the connect flow: opens Last.fm's approval page in the system browser. Requires settings.lastFmApiKey/lastFmApiSecret to already be filled in. */
  connect: () => void;
  /** Windows only - called once the user says they've approved BPMix in the browser, to exchange the pending token for a session. If Last.fm reports the token still isn't approved (error code 14), status drops back to 'awaitingAuthorization' so the user can try again after actually approving it. */
  confirmAuthorized: () => void;
  disconnect: () => void;
}

/**
 * Android + Windows (and any other non-web platform) implementation - see
 * useLastFmConnection.web.ts for the separate web version (a DOM-based
 * popup + postMessage flow that can't share this file's code, since
 * mobile's own tsconfig has no "dom" lib to typecheck against - see
 * CLAUDE.md's note on `.web.ts` files for why the bundler, not `tsc`, is
 * what actually picks between the two per platform).
 *
 * - android: buildWebAuthUrl (no auth.getToken call - Last.fm mints the
 *   token itself) with ANDROID_CALLBACK_URL as the `cb` redirect - the OS
 *   hands that straight back to BPMix as a verified Android App Link (see
 *   ANDROID_CALLBACK_URL's doc), no manual step needed.
 * - windows (or anything else without a callback route registered): the
 *   original desktop-app flow - auth.getToken, open the approval page with
 *   no callback at all, and wait for the user to come back and press
 *   confirmAuthorized() themselves.
 */
export function useLastFmConnection(settings: AppSettings, onUpdateSettings: (patch: Partial<AppSettings>) => void): UseLastFmConnectionResult {
  const [status, setStatus] = useState<LastFmConnectionStatus>(settings.lastFmSessionKey ? 'connected' : 'disconnected');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // The credentials a connect() call is actually running against - read by
  // the Android deep-link listener below, which fires well after connect()
  // returns and can't just close over its own local `credentials` const
  // from that render.
  const activeCredentialsRef = useRef<LastFmCredentials | null>(null);

  const finishWithToken = useCallback(
    (token: string) => {
      const credentials = activeCredentialsRef.current;
      if (!credentials) return;
      setErrorMessage(null);
      setStatus('confirming');
      void (async () => {
        try {
          const session = await getSession(credentials, token);
          activeCredentialsRef.current = null;
          onUpdateSettings({ lastFmSessionKey: session.sessionKey, lastFmUsername: session.username });
          setStatus('connected');
        } catch (err) {
          setErrorMessage(err instanceof LastFmError ? err.message : 'Could not reach Last.fm.');
          setStatus('disconnected');
        }
      })();
    },
    [onUpdateSettings],
  );

  // bpmix://lastfm-callback?token=... arriving as an ordinary deep link - a
  // second, independent 'url' listener alongside each app's own
  // applyDeepLink (RN's Linking event supports multiple subscribers),
  // filtered to just this one path so it never interferes with the
  // launcher-shortcut routing that already owns this event.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.startsWith(ANDROID_CALLBACK_URL) && !url.startsWith(ANDROID_LEGACY_CALLBACK_URL)) return;
      const match = /[?&]token=([^&]+)/.exec(url);
      if (match?.[1]) finishWithToken(decodeURIComponent(match[1]));
    });
    return () => subscription.remove();
  }, [finishWithToken]);

  const connect = useCallback(() => {
    if (!settings.lastFmApiKey || !settings.lastFmApiSecret) {
      setErrorMessage('Enter a Last.fm API key and secret first.');
      return;
    }
    const credentials = { apiKey: settings.lastFmApiKey, apiSecret: settings.lastFmApiSecret };
    activeCredentialsRef.current = credentials;
    setErrorMessage(null);

    if (Platform.OS === 'android') {
      setStatus('awaitingAuthorization');
      void Linking.openURL(buildWebAuthUrl(credentials, ANDROID_CALLBACK_URL));
      return;
    }

    // Windows fallback - desktop-app flow, manual confirmAuthorized() below.
    setStatus('requestingToken');
    void (async () => {
      try {
        const token = await getAuthToken(credentials);
        setPendingToken(token);
        setStatus('awaitingAuthorization');
        await Linking.openURL(buildAuthUrl(credentials, token));
      } catch (err) {
        setErrorMessage(err instanceof LastFmError ? err.message : 'Could not reach Last.fm.');
        activeCredentialsRef.current = null;
        setStatus('disconnected');
      }
    })();
  }, [settings.lastFmApiKey, settings.lastFmApiSecret]);

  // Deliberately separate from finishWithToken (used by the automatic
  // Android callback above): that only ever fires after Last.fm's own site
  // has already confirmed approval, so there's no "not yet" case to retry.
  // This manual path can genuinely be called before the user has actually
  // approved anything yet, so it keeps pendingToken around across a code-14
  // ("Unauthorized Token") rejection instead of discarding it, letting the
  // user just press the same button again after actually approving it.
  const confirmAuthorized = useCallback(() => {
    if (!pendingToken) return;
    const credentials = activeCredentialsRef.current;
    if (!credentials) return;
    setErrorMessage(null);
    setStatus('confirming');
    void (async () => {
      try {
        const session = await getSession(credentials, pendingToken);
        activeCredentialsRef.current = null;
        setPendingToken(null);
        onUpdateSettings({ lastFmSessionKey: session.sessionKey, lastFmUsername: session.username });
        setStatus('connected');
      } catch (err) {
        if (err instanceof LastFmError && err.code === 14) {
          setErrorMessage('Not approved yet - approve BPMix in the browser tab, then try again.');
        } else {
          setErrorMessage(err instanceof LastFmError ? err.message : 'Could not reach Last.fm.');
        }
        setStatus('awaitingAuthorization');
      }
    })();
  }, [pendingToken, onUpdateSettings]);

  const disconnect = useCallback(() => {
    activeCredentialsRef.current = null;
    setPendingToken(null);
    setErrorMessage(null);
    setStatus('disconnected');
    onUpdateSettings({ lastFmSessionKey: null, lastFmUsername: null });
  }, [onUpdateSettings]);

  return {
    status,
    username: settings.lastFmUsername,
    errorMessage,
    needsManualConfirmation: Platform.OS !== 'android',
    connect,
    confirmAuthorized,
    disconnect,
  };
}

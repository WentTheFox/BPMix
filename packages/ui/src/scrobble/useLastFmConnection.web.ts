import { buildWebAuthUrl, deriveLastFmStatus, getSession, LastFmError } from '@bpmix/core';
import type { LastFmAttemptStatus, LastFmCredentials } from '@bpmix/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../settings/types';
import type { UseLastFmConnectionResult } from './useLastFmConnection';

/**
 * Web implementation - see useLastFmConnection.ts's doc for why this is a
 * separate file rather than a `Platform.OS === 'web'` branch in the shared
 * one (DOM types aren't available under mobile's tsconfig).
 *
 * Opens a popup to Last.fm's auth page with `cb` pointing at a same-origin
 * `lastfm-callback.html` (apps/web/public/) - that page reads the token
 * Last.fm appends once the user approves and posts it back via
 * `window.postMessage` before closing itself, so there's no manual
 * "I've approved it" step needed here (needsManualConfirmation is always
 * false). A poll on `popup.closed` is the only way to notice the user
 * closed the popup without approving anything - there's no event for that.
 */
export function useLastFmConnection(settings: AppSettings, onUpdateSettings: (patch: Partial<AppSettings>) => void): UseLastFmConnectionResult {
  // Only the in-flight attempt is local state; the resting status is derived from the stored session
  // key (see deriveLastFmStatus for why it can't be initialised from it once at mount).
  const [attempt, setAttempt] = useState<LastFmAttemptStatus>('idle');
  const status = deriveLastFmStatus(attempt, settings.lastFmSessionKey);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeCredentialsRef = useRef<LastFmCredentials | null>(null);
  const popupPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const finishWithToken = useCallback(
    (token: string) => {
      const credentials = activeCredentialsRef.current;
      if (!credentials) return;
      setErrorMessage(null);
      setAttempt('confirming');
      void (async () => {
        try {
          const session = await getSession(credentials, token);
          activeCredentialsRef.current = null;
          onUpdateSettings({ lastFmSessionKey: session.sessionKey, lastFmUsername: session.username });
          setAttempt('idle');
        } catch (err) {
          setErrorMessage(err instanceof LastFmError ? err.message : 'Could not reach Last.fm.');
          setAttempt('idle');
        }
      })();
    },
    [onUpdateSettings],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: unknown; token?: unknown } | null;
      if (data?.source === 'bpmix-lastfm' && typeof data.token === 'string') finishWithToken(data.token);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [finishWithToken]);

  useEffect(
    () => () => {
      if (popupPollRef.current) clearInterval(popupPollRef.current);
    },
    [],
  );

  const connect = useCallback(() => {
    if (!settings.lastFmApiKey || !settings.lastFmApiSecret) {
      setErrorMessage('Enter a Last.fm API key and secret first.');
      return;
    }
    const credentials = { apiKey: settings.lastFmApiKey, apiSecret: settings.lastFmApiSecret };
    activeCredentialsRef.current = credentials;
    setErrorMessage(null);

    const callbackUrl = `${window.location.origin}/lastfm-callback.html`;
    const popup = window.open(buildWebAuthUrl(credentials, callbackUrl), 'bpmix-lastfm-auth', 'width=500,height=650');
    if (!popup) {
      setErrorMessage('Your browser blocked the Last.fm authorization popup - allow popups for this site and try again.');
      activeCredentialsRef.current = null;
      return;
    }
    setAttempt('awaitingAuthorization');
    if (popupPollRef.current) clearInterval(popupPollRef.current);
    popupPollRef.current = setInterval(() => {
      if (!popup.closed) return;
      if (popupPollRef.current) clearInterval(popupPollRef.current);
      popupPollRef.current = null;
      // No-op if a message already moved status past this (see
      // finishWithToken) - only resets an actually-abandoned attempt (the
      // user closed the popup without approving).
      setAttempt((current) => (current === 'awaitingAuthorization' ? 'idle' : current));
    }, 500);
  }, [settings.lastFmApiKey, settings.lastFmApiSecret]);

  const disconnect = useCallback(() => {
    activeCredentialsRef.current = null;
    setErrorMessage(null);
    setAttempt('idle');
    onUpdateSettings({ lastFmSessionKey: null, lastFmUsername: null });
  }, [onUpdateSettings]);

  return {
    status,
    username: settings.lastFmUsername,
    errorMessage,
    needsManualConfirmation: false,
    connect,
    // Never invoked - needsManualConfirmation is always false on web.
    confirmAuthorized: () => {},
    disconnect,
  };
}

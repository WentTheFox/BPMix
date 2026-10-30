import { ApiError, createServerScrobbleSink, deriveLastFmStatus, type LastFmAttemptStatus, type LastFmStatusDto, type ScrobbleSink, type ServerMode } from '@bpmix/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import type { UseLastFmConnectionResult } from './useLastFmConnection';

const message = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);

/**
 * Last.fm through the server: the link lives there (one per user, shared by every device), so connecting
 * is "ask the server for an approval page, approve it, tell the server you did" and scrobbles go to the
 * server too. Returns the same shape the Settings screen already shows for the local flow, plus the
 * ScrobbleSink for the scrobbler.
 */
export function useServerLastFm(serverMode: ServerMode | undefined, signedIn: boolean): { connection: UseLastFmConnectionResult; sink: ScrobbleSink | null } {
  const [link, setLink] = useState<LastFmStatusDto | null>(null);
  const [attempt, setAttempt] = useState<LastFmAttemptStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!serverMode || !signedIn) {
      setLink(null);
      return;
    }
    let cancelled = false;
    void serverMode.lastFmStatus().then((status) => {
      if (!cancelled) setLink(status);
    });
    return () => {
      cancelled = true;
    };
  }, [serverMode, signedIn]);

  const connect = useCallback(() => {
    const api = serverMode?.getApi();
    if (!api) {
      setErrorMessage('Sign in to the server first.');
      return;
    }
    setErrorMessage(null);
    setAttempt('requestingToken');
    void api
      .lastFmConnect()
      .then(({ authUrl }) => {
        setAttempt('awaitingAuthorization');
        void Linking.openURL(authUrl);
      })
      .catch((err: unknown) => {
        setErrorMessage(message(err, 'Could not reach the server.'));
        setAttempt('idle');
      });
  }, [serverMode]);

  const confirmAuthorized = useCallback(() => {
    const api = serverMode?.getApi();
    if (!api || !serverMode) return;
    setErrorMessage(null);
    setAttempt('confirming');
    void api
      .lastFmComplete()
      .then(async (status) => {
        await serverMode.cacheLastFmStatus(status);
        setLink(status);
        setAttempt('idle');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'not_authorized') {
          setErrorMessage('Not approved yet - approve BPMix on the Last.fm page, then try again.');
          setAttempt('awaitingAuthorization');
          return;
        }
        setErrorMessage(message(err, 'Could not reach the server.'));
        setAttempt('idle');
      });
  }, [serverMode]);

  const disconnect = useCallback(() => {
    const api = serverMode?.getApi();
    if (!api || !serverMode) return;
    setErrorMessage(null);
    void api
      .lastFmDisconnect()
      .then(async (status) => {
        await serverMode.cacheLastFmStatus(status);
        setLink(status);
        setAttempt('idle');
      })
      .catch((err: unknown) => setErrorMessage(message(err, 'Could not reach the server.')));
  }, [serverMode]);

  const connected = link?.connected === true;
  const sink = useMemo(() => (connected && serverMode ? createServerScrobbleSink(() => serverMode.getApi()) : null), [connected, serverMode]);

  return {
    connection: {
      status: deriveLastFmStatus(attempt, connected ? 'server' : null),
      username: link?.connected ? link.username : null,
      errorMessage,
      // The server can't tell the app when approval happens (no callback), so the person says so.
      needsManualConfirmation: true,
      connect,
      confirmAuthorized,
      disconnect,
    },
    sink,
  };
}

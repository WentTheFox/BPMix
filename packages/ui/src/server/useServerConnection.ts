import { NetworkError, refreshLibrary, syncServerLibrary, type ServerMode, type ServerStatus } from '@bpmix/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Linking } from 'react-native';
import { navigateTo } from '../navigateTo';
import { useAppDispatch } from '../store/hooks';

export type ServerSignInPhase = 'idle' | 'starting' | 'awaitingApproval' | 'denied' | 'expired' | 'failed';

export interface UseServerConnectionResult {
  status: ServerStatus;
  /** The web app on the server itself: signing in means the server's own sign-in page (a browser session), not typing an address and approving a code. */
  usesBrowserSession: boolean;
  phase: ServerSignInPhase;
  /** While waiting for approval: what to show and where to send the person. */
  pendingCode: { userCode: string; verificationUri: string } | null;
  errorMessage: string | null;
  /** Asks the server for a sign-in code for this device and waits for it to be approved in a browser. */
  signIn: (address: string) => void;
  cancelSignIn: () => void;
  openApprovalPage: () => void;
  syncNow: () => void;
  signOut: () => void;
}

/**
 * Drives the "BPMix server" connection: native sign-in with a device code (the person approves it in
 * a browser, so passkeys and 2FA happen there, not in the app), manual resync, and sign-out. Signing
 * in or out reloads the library so the screens switch between the server's and the local folders'.
 */
export function useServerConnection(serverMode: ServerMode | undefined): UseServerConnectionResult | null {
  const dispatch = useAppDispatch();
  const [phase, setPhase] = useState<ServerSignInPhase>('idle');
  const [pendingCode, setPendingCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const status = useSyncExternalStore(
    useCallback((onChange: () => void) => serverMode?.subscribe(onChange) ?? (() => undefined), [serverMode]),
    () => serverMode?.getStatus() ?? NO_SERVER,
  );

  useEffect(() => () => controllerRef.current?.abort(), []);

  const signIn = useCallback(
    (address: string) => {
      if (!serverMode) return;
      if (serverMode.usesBrowserSession) {
        navigateTo(`/login?next=${encodeURIComponent('/')}`);
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setPhase('starting');
      setErrorMessage(null);
      setPendingCode(null);
      void (async () => {
        try {
          const result = await serverMode.signInWithDeviceCode(
            address,
            (progress) => {
              if (progress.kind === 'code') {
                setPendingCode({ userCode: progress.userCode, verificationUri: progress.verificationUri });
                setPhase('awaitingApproval');
              }
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if ('token' in result) {
            setPhase('idle');
            setPendingCode(null);
            // The library screens switch to the server's: show the (empty) cache, then check in and fill it.
            void dispatch(refreshLibrary());
          } else {
            setPhase('denied' in result ? 'denied' : 'expired');
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          setPhase('failed');
          setErrorMessage(err instanceof NetworkError ? `Couldn't reach ${address.trim()}. Check the address, and that the server is running and reachable from this device.` : err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [dispatch, serverMode],
  );

  const cancelSignIn = useCallback(() => {
    controllerRef.current?.abort();
    setPhase('idle');
    setPendingCode(null);
    setErrorMessage(null);
  }, []);

  const openApprovalPage = useCallback(() => {
    if (pendingCode) void Linking.openURL(pendingCode.verificationUri);
  }, [pendingCode]);

  const syncNow = useCallback(() => {
    void dispatch(syncServerLibrary());
  }, [dispatch]);

  const signOut = useCallback(() => {
    if (!serverMode) return;
    void serverMode.signOut().then(() => dispatch(refreshLibrary()));
  }, [dispatch, serverMode]);

  if (!serverMode) return null;
  return { status, usesBrowserSession: serverMode.usesBrowserSession, phase, pendingCode, errorMessage, signIn, cancelSignIn, openApprovalPage, syncNow, signOut };
}

const NO_SERVER: ServerStatus = { active: false, url: '', userName: null, isAdmin: null, lastSyncedAtMs: null, syncing: false, offline: false, error: null };

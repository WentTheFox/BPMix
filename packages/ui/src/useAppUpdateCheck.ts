import { checkForUpdate, errorMessage, logLibraryAction, parseChecksumsFile, type AppUpdateNativeBridge, type AvailableUpdate } from '@bpmix/core';
import { useCallback, useMemo, useState } from 'react';
import type { AppUpdateState } from './settings/SettingsScreen';

export interface UseAppUpdateCheckInput {
  /** BUILD_VERSION (@bpmix/core's buildInfo.ts) - what the running build actually is. */
  currentVersion: string;
  /** Null on any platform with no install flow yet (web, Windows) - the returned status stays 'idle' forever and onCheck/onDownloadAndInstall are no-ops, rather than this hook being conditionally called at all (React's rules of hooks - see apps/mobile/App.tsx, the only caller, which is shared between Android and Windows). */
  bridge: AppUpdateNativeBridge | null;
}

/**
 * Drives SettingsScreen's "Updates" row: check GitHub's latest release
 * against the running build's own version, then (if newer) download its
 * APK, verify its SHA-256 against the release's own checksums.txt before
 * ever calling installApk - a completed download is never trusted on
 * faith. See AppUpdateNativeBridge's doc for why the actual download/
 * install is platform-injected rather than called directly from here.
 */
export function useAppUpdateCheck({ currentVersion, bridge }: UseAppUpdateCheckInput): AppUpdateState {
  const [status, setStatus] = useState<AppUpdateState['status']>('idle');
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [errorMessageState, setErrorMessageState] = useState<string | undefined>(undefined);

  const onCheck = useCallback(async () => {
    if (!bridge) return;
    setStatus('checking');
    setErrorMessageState(undefined);
    try {
      const update = await checkForUpdate(currentVersion);
      setAvailableUpdate(update);
      setStatus(update ? 'available' : 'upToDate');
      logLibraryAction('appUpdate:check', { available: !!update, version: update?.version });
    } catch (err) {
      setStatus('error');
      setErrorMessageState(errorMessage(err));
      logLibraryAction('appUpdate:check:failed', { error: String(err) });
    }
  }, [bridge, currentVersion]);

  const onDownloadAndInstall = useCallback(async () => {
    if (!bridge || !availableUpdate) return;
    try {
      if (!(await bridge.canRequestInstallPackages())) {
        await bridge.requestInstallPermission();
        setStatus('error');
        setErrorMessageState('Grant "install unknown apps" permission, then try again.');
        return;
      }

      setStatus('downloading');
      const { path, sha256 } = await bridge.downloadFile(availableUpdate.apkAsset.browserDownloadUrl, availableUpdate.apkAsset.name);

      if (availableUpdate.checksumsAsset) {
        const checksumsText = await (await fetch(availableUpdate.checksumsAsset.browserDownloadUrl)).text();
        const expectedSha256 = parseChecksumsFile(checksumsText, availableUpdate.apkAsset.name);
        if (expectedSha256 && expectedSha256 !== sha256) {
          setStatus('error');
          setErrorMessageState('Downloaded file failed checksum verification - try again.');
          logLibraryAction('appUpdate:checksumMismatch', { expected: expectedSha256, actual: sha256 });
          return;
        }
      }

      setStatus('installing');
      await bridge.installApk(path);
      logLibraryAction('appUpdate:install', { version: availableUpdate.version });
      // No further state change here - installApk hands off to the system
      // installer's own UI, which the user interacts with directly; this
      // screen has nothing more to report either way.
    } catch (err) {
      setStatus('error');
      setErrorMessageState(errorMessage(err));
      logLibraryAction('appUpdate:downloadAndInstall:failed', { error: String(err) });
    }
  }, [bridge, availableUpdate]);

  return useMemo(
    () => ({ status, availableVersion: availableUpdate?.version, errorMessage: errorMessageState, onCheck: () => void onCheck(), onDownloadAndInstall: () => void onDownloadAndInstall() }),
    [status, availableUpdate, errorMessageState, onCheck, onDownloadAndInstall],
  );
}

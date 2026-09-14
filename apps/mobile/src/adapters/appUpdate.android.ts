import type { AppUpdateNativeBridge } from '@bpmix/core';
import { NativeModules } from 'react-native';

interface NativeAppUpdate {
  canRequestInstallPackages(): Promise<boolean>;
  requestInstallPermission(): Promise<void>;
  downloadFile(url: string, fileName: string): Promise<{ path: string; sha256: string }>;
  installApk(filePath: string): Promise<void>;
}

const native = NativeModules.BPMixAppUpdate as NativeAppUpdate;

/** Thin wrapper over AppUpdateModule.kt - see AppUpdateNativeBridge's doc for the contract this fulfills. */
export function createAppUpdateBridge(): AppUpdateNativeBridge {
  return {
    canRequestInstallPackages: () => native.canRequestInstallPackages(),
    requestInstallPermission: () => native.requestInstallPermission(),
    downloadFile: (url, fileName) => native.downloadFile(url, fileName),
    installApk: (filePath) => native.installApk(filePath),
  };
}

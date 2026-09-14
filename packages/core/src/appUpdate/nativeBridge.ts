/**
 * Platform-specific half of the update flow (downloading a release asset to
 * a real file, and triggering the OS package installer on it) - the
 * version-check itself (checkForUpdate.ts) is plain fetch + string
 * comparison and needs no native code, but this part does. Only
 * apps/mobile/src/adapters/appUpdate.android.ts implements this for real
 * (backed by the AppUpdateModule native module); other platforms have no
 * APK/install concept, so useAppUpdateCheck (packages/ui) is only ever
 * driven with a bridge on Android in the first place.
 */
export interface AppUpdateNativeBridge {
  /** Downloads `url` to a private, app-managed location named `fileName`, returning its path and the SHA-256 computed while streaming it to disk. */
  downloadFile(url: string, fileName: string): Promise<{ path: string; sha256: string }>;
  /** Launches the OS package installer for a file downloadFile() already saved. */
  installApk(filePath: string): Promise<void>;
  /** Whether this app is currently allowed to trigger a package install (Android 8+'s per-app "install unknown apps" grant). */
  canRequestInstallPackages(): Promise<boolean>;
  /** Opens the system settings screen for granting canRequestInstallPackages() - fire-and-forget; the caller re-checks canRequestInstallPackages() once the app resumes. */
  requestInstallPermission(): Promise<void>;
}

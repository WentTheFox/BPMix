import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';
import { NativeModules } from 'react-native';
import { base64ToArrayBuffer } from './base64';

/**
 * Backed by a real native module (windows/Mobile/FileAccessModule.h) built
 * directly against WinRT's StorageFolder/FutureAccessList APIs - there is no
 * maintained folder-picker/file-access library for the current
 * react-native-windows C++/WinRT template, so this is a from-scratch
 * equivalent of the Android adapter's react-native-scoped-storage usage.
 *
 * FileRef.id is "<futureAccessListToken>|<relativePath>" (encoded natively);
 * see the module header comment for why that's enough state on its own,
 * unlike Android's opaque content:// URIs which need a client-side cache.
 */
interface NativeFileAccess {
  pickFolder(): Promise<{ id: string; displayName: string } | null>;
  listGrantedRoots(): Promise<Array<{ id: string; displayName: string }>>;
  revokeRoot(rootId: string): Promise<void>;
  listDirectory(
    rootId: string,
    relativePath: string,
  ): Promise<Array<{ type: 'file' | 'directory'; name: string; relativePath: string; file?: FileRef }>>;
  readFileBytesBase64(fileId: string): Promise<string>;
  readFileText(fileId: string): Promise<string>;
}

const native = NativeModules.BPMixFileAccess as NativeFileAccess;

/** Never thrown here - Windows has no MANAGE_EXTERNAL_STORAGE equivalent to gate on. Exported only for the same shared-App.tsx-import reason as registerRootBrowser below. */
export class AllFilesAccessRequiredError extends Error {}

/** No-op here - Windows's requestRoot() (pickFolder above) has nothing to re-open. */
export function openAllFilesAccessSettings(): void {}

/**
 * Always null here - Windows has no unrestricted-storage equivalent to
 * MANAGE_EXTERNAL_STORAGE, so a location outside an already-granted root
 * always needs a real FolderPicker prompt (pickFolder above), same as
 * adding a whole new root does. Callers fall back to picking a subfolder
 * of an existing root instead - see addLyricsFolder in apps/mobile/App.tsx.
 */
export async function browseDeviceStorage(): Promise<{ path: string; displayName: string } | null> {
  return null;
}

/**
 * Identity here - Windows has no MANAGE_EXTERNAL_STORAGE-style whole-device
 * browsing (see browseDeviceStorage above), so every LyricsScope's rootId
 * is always a real granted root's id, which already has a proper
 * displayName from listGrantedRoots(). Exported only so App.tsx's shared
 * rootDisplayName fallback (for Android's lyrics-scope-as-its-own-root
 * case - see fileAccess.android.ts's toRelativeDisplay) resolves on this
 * platform too, where that fallback is never actually reached.
 */
export function toRelativeDisplay(path: string): string {
  return path;
}

/**
 * No-op here - Windows still grants roots via its own native FolderPicker
 * (pickFolder above), not FolderBrowser. Exported only so App.tsx's shared
 * registration call (needed for Android's MANAGE_EXTERNAL_STORAGE-based
 * requestRoot - see fileAccess.android.ts) resolves on this platform too.
 */
export function registerRootBrowser(
  _browser: ((storageRootPath: string, storageRootDisplayName: string) => Promise<string | null>) | null,
): void {}

export function createFileAccess(): FileAccess {
  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      return native.pickFolder();
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      return native.listGrantedRoots();
    },

    async revokeRoot(rootId: string): Promise<void> {
      await native.revokeRoot(rootId);
    },

    async listDirectory(rootId: string, relativePath = ''): Promise<DirectoryEntry[]> {
      return native.listDirectory(rootId, relativePath);
    },

    async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
      const base64 = await native.readFileBytesBase64(ref.id);
      return base64ToArrayBuffer(base64);
    },

    async readFileText(ref: FileRef): Promise<string> {
      return native.readFileText(ref.id);
    },
  };
}

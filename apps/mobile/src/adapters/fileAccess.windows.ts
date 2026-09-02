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

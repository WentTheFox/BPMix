import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '@bpmix/core';
import { NativeModules } from 'react-native';
import { base64ToArrayBuffer } from './base64';

interface NativeFileEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  lastModifiedMs: number;
}

interface NativeFileAccess {
  hasAllFilesAccess(): Promise<boolean>;
  requestAllFilesAccess(): void;
  getExternalStorageRoot(): Promise<string>;
  listDirectory(path: string): Promise<NativeFileEntry[]>;
  readFileText(path: string): Promise<string>;
  readFileBytesBase64(path: string): Promise<string>;
  readLocalText(fileName: string): Promise<string | null>;
  writeLocalText(fileName: string, content: string): Promise<void>;
}

const native = NativeModules.BPMixFileAccess as NativeFileAccess;
const ROOTS_FILE = 'granted-roots.json';

/**
 * Plain java.io.File paths, gated on MANAGE_EXTERNAL_STORAGE, instead of
 * Storage Access Framework tree URIs - see BPMixFileAccessModule.kt's
 * header comment for why: a broken Samsung "My Files" SAF picker made
 * requesting a new folder grant unreliable (rejecting every folder,
 * including freshly-created ones, while its own normal browse mode saw
 * them fine). A root's id is just its absolute path - much simpler than
 * the SAF adapter's uri-cache-by-relativePath scheme, since a plain path
 * composes with "/" on its own.
 */
function joinPath(base: string, relativePath?: string): string {
  return relativePath ? `${base}/${relativePath}` : base;
}

async function readRootPaths(): Promise<{ path: string; displayName: string }[]> {
  const text = await native.readLocalText(ROOTS_FILE);
  if (!text) return [];
  try {
    return JSON.parse(text) as { path: string; displayName: string }[];
  } catch {
    return [];
  }
}

async function writeRootPaths(roots: { path: string; displayName: string }[]): Promise<void> {
  await native.writeLocalText(ROOTS_FILE, JSON.stringify(roots));
}

/** Given the device's external storage root path/display name, browse it and resolve with the chosen relativePath ('' for the root itself), or null on cancel. */
type BrowseForRoot = (storageRootPath: string, storageRootDisplayName: string) => Promise<string | null>;
/**
 * Bridges requestRoot() (a plain async FileAccess call) to FolderBrowser (a
 * React component) - App.tsx registers this once, rendering FolderBrowser
 * starting at the device's external storage root when it's called, and
 * resolving with the relativePath the user picked (or null on cancel).
 */
let browseForRoot: BrowseForRoot | null = null;
export function registerRootBrowser(browser: BrowseForRoot | null): void {
  browseForRoot = browser;
}

/** Thrown by requestRoot() when MANAGE_EXTERNAL_STORAGE isn't granted yet - a distinct class (not just an error message) so callers can offer a direct "open Settings" action instead of just displaying the text. */
export class AllFilesAccessRequiredError extends Error {
  constructor() {
    super('Grant "All files access" for BPMix in Settings, then try again.');
    this.name = 'AllFilesAccessRequiredError';
  }
}

/** Re-opens the same system settings screen requestRoot() already opens automatically on first denial - exposed so a UI can offer it as a retry action if the user navigated away without granting it. */
export function openAllFilesAccessSettings(): void {
  native.requestAllFilesAccess();
}

/**
 * Browses the whole of external storage (not just an already-granted root)
 * and resolves with the absolute path the user landed on, or null if they
 * cancelled or MANAGE_EXTERNAL_STORAGE isn't granted yet (which also
 * re-opens the same settings screen requestRoot() does, same as there).
 * Doesn't persist anything - unlike requestRoot(), this isn't creating a
 * new library root, just picking a location (e.g. a lyrics folder that
 * lives next to, not inside, an already-added music root - MANAGE_EXTERNAL_STORAGE
 * has no per-folder grant to confine that to on Android, unlike the SAF/
 * FolderPicker-based Windows and web adapters, which still need a location
 * to be within a root they already hold a grant for).
 */
export async function browseDeviceStorage(): Promise<{ path: string; displayName: string } | null> {
  const hasAccess = await native.hasAllFilesAccess();
  if (!hasAccess) {
    native.requestAllFilesAccess();
    return null;
  }
  if (!browseForRoot) {
    return null;
  }
  const storageRoot = await native.getExternalStorageRoot();
  // Not storageRoot's own last path segment - that's always the numeric
  // Android user-profile id (e.g. "0" from "/storage/emulated/0"), not
  // anything a user would recognize as their device's storage.
  const storageRootDisplayName = 'Internal storage';
  const relativePath = await browseForRoot(storageRoot, storageRootDisplayName);
  if (relativePath === null) return null; // user cancelled
  const path = joinPath(storageRoot, relativePath);
  // The full absolute path rather than just its last segment - matches how
  // a lyrics scope with no matching granted root ends up displaying (see
  // LyricsFolderSection's rootDisplayName fallback), and stays useful even
  // once a user has more than one root that happens to share a name. Also
  // what listGrantedRoots() shows for every root regardless of what's
  // persisted here, so this only actually matters for the very first
  // render right after picking a brand-new root.
  const displayName = relativePath ? path : storageRootDisplayName;
  return { path, displayName };
}

export function createFileAccess(): FileAccess {
  return {
    async requestRoot(): Promise<GrantedRoot | null> {
      const hasAccessBeforeBrowsing = await native.hasAllFilesAccess();
      const browsed = await browseDeviceStorage();
      if (!browsed) {
        // browseDeviceStorage() already re-opened Settings for us if the
        // permission was the reason it came back empty.
        if (!hasAccessBeforeBrowsing) throw new AllFilesAccessRequiredError();
        return null; // user cancelled
      }
      const roots = await readRootPaths();
      if (!roots.some((r) => r.path === browsed.path)) {
        roots.push({ path: browsed.path, displayName: browsed.displayName });
        await writeRootPaths(roots);
      }
      return { id: browsed.path, displayName: browsed.displayName };
    },

    async listGrantedRoots(): Promise<GrantedRoot[]> {
      const roots = await readRootPaths();
      // Always the full path (not whatever was persisted at grant time) -
      // otherwise a root added before displayName started storing the full
      // path (see browseDeviceStorage's doc) would keep showing just its
      // last segment until re-added.
      return roots.map((r) => ({ id: r.path, displayName: r.path }));
    },

    async revokeRoot(rootId: string): Promise<void> {
      const roots = await readRootPaths();
      await writeRootPaths(roots.filter((r) => r.path !== rootId));
    },

    async listDirectory(rootId: string, relativePath = ''): Promise<DirectoryEntry[]> {
      const fullPath = joinPath(rootId, relativePath);
      const children = await native.listDirectory(fullPath);
      const prefix = relativePath ? `${relativePath}/` : '';

      return children.map((child) => {
        const childRelativePath = prefix + child.name;
        if (child.isDirectory) {
          return { type: 'directory', name: child.name, relativePath: childRelativePath };
        }
        const fileRef: FileRef = {
          id: joinPath(rootId, childRelativePath),
          name: child.name,
          relativePath: childRelativePath,
          sizeBytes: child.sizeBytes,
          lastModifiedMs: child.lastModifiedMs,
        };
        return { type: 'file', name: child.name, relativePath: childRelativePath, file: fileRef };
      });
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

import {
  errorMessage,
  logLibraryAction,
  scanRoot,
  type FileAccess,
  type GrantedRoot,
  type LibraryStore,
} from '@bpmix/core';
import { useCallback, useState } from 'react';
import { lyricsScopeKey } from './LyricsFolderSection';

export interface LibraryRootActionsInput {
  fileAccess: FileAccess;
  libraryStore: LibraryStore;
  grantedRoots: GrantedRoot[];
  refresh: () => Promise<unknown>;
  setError: (err: string | null) => void;
  /**
   * Called at the very start of addFolder, before requesting a root -
   * mobile resets its AllFilesAccessRequiredError banner state here since
   * a fresh attempt should clear a stale banner from a previous failed
   * one. Web has no such banner and omits this.
   */
  onAddFolderStart?: () => void;
  /**
   * Called in addition to (not instead of) the generic setError/
   * logLibraryAction handling when addFolder's try block throws - lets
   * mobile flag AllFilesAccessRequiredError specifically to show its
   * "Open Settings" banner action. Omitted on web, which has no
   * platform-specific error to distinguish.
   */
  onAddFolderError?: (err: unknown) => void;
  /**
   * Android-only: browses the whole of external storage the same way
   * Add Folder does, tried before falling back to a real OS directory
   * picker (there's no per-folder OS grant to confine a lyrics location
   * to a subfolder of an already-added root). Omitted on web, which
   * always uses fileAccess.requestRoot('lyrics') directly - full parity,
   * just without this Android-only shortcut.
   */
  browseDeviceStorage?: () => Promise<{ path: string } | null>;
}

export interface LibraryRootActions {
  addFolder: () => Promise<void>;
  rescan: (rootId: string) => Promise<void>;
  removeRoot: (rootId: string) => Promise<void>;
  addLyricsFolder: () => Promise<void>;
  rescanLyricsScope: (rootId: string, relativePath: string) => Promise<void>;
  removeLyricsScope: (rootId: string, relativePath: string) => Promise<void>;
  busyRootId: string | null;
  busyLyricsScopeKey: string | null;
}

/**
 * Shared library root/lyrics-scope management actions - identical between
 * apps/mobile/App.tsx and apps/web/src/App.tsx before this extraction,
 * except for addFolder/addLyricsFolder's platform-specific error handling
 * and Android-only browseDeviceStorage shortcut, both threaded through as
 * optional seams rather than duplicated per app.
 */
export function useLibraryRootActions(input: LibraryRootActionsInput): LibraryRootActions {
  const { fileAccess, libraryStore, grantedRoots, refresh, setError, onAddFolderStart, onAddFolderError, browseDeviceStorage } = input;

  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [busyLyricsScopeKey, setBusyLyricsScopeKey] = useState<string | null>(null);

  const addFolder = useCallback(async () => {
    setError(null);
    onAddFolderStart?.();
    try {
      const root = await fileAccess.requestRoot();
      if (!root) return; // user cancelled the picker
      setBusyRootId(root.id);
      await scanRoot(fileAccess, libraryStore, root.id);
      await refresh();
      logLibraryAction('addFolder', { rootId: root.id });
    } catch (err) {
      setError(errorMessage(err));
      logLibraryAction('addFolder:failed', { error: String(err) });
      onAddFolderError?.(err);
    } finally {
      setBusyRootId(null);
    }
  }, [fileAccess, libraryStore, refresh, setError, onAddFolderStart, onAddFolderError]);

  const rescan = useCallback(
    async (rootId: string) => {
      setError(null);
      setBusyRootId(rootId);
      try {
        await scanRoot(fileAccess, libraryStore, rootId);
        await refresh();
        logLibraryAction('rescan', { rootId });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('rescan:failed', { rootId, error: String(err) });
      } finally {
        setBusyRootId(null);
      }
    },
    [fileAccess, libraryStore, refresh, setError],
  );

  const removeRoot = useCallback(
    async (rootId: string) => {
      setError(null);
      try {
        await fileAccess.revokeRoot(rootId);
        await refresh();
        logLibraryAction('removeRoot', { rootId });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('removeRoot:failed', { rootId, error: String(err) });
      }
    },
    [fileAccess, refresh, setError],
  );

  const addLyricsFolder = useCallback(async () => {
    setError(null);
    try {
      const browsed = await browseDeviceStorage?.();
      if (browsed) {
        await libraryStore.addLyricsScope({ rootId: browsed.path, relativePath: '' });
        await refresh();
        logLibraryAction('addLyricsFolder', { rootId: browsed.path });
        return;
      }
      const root = await fileAccess.requestRoot('lyrics');
      if (!root) return; // user cancelled the picker
      await libraryStore.addLyricsScope({ rootId: root.id, relativePath: '' });
      await refresh();
      logLibraryAction('addLyricsFolder', { rootId: root.id });
    } catch (err) {
      setError(errorMessage(err));
      logLibraryAction('addLyricsFolder:failed', { error: String(err) });
    }
  }, [fileAccess, libraryStore, refresh, setError, browseDeviceStorage]);

  const rescanLyricsScope = useCallback(
    async (rootId: string, relativePath: string) => {
      setError(null);
      setBusyLyricsScopeKey(lyricsScopeKey({ rootId, relativePath }));
      try {
        await refresh();
        logLibraryAction('rescanLyricsScope', { rootId, relativePath });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('rescanLyricsScope:failed', { rootId, relativePath, error: String(err) });
      } finally {
        setBusyLyricsScopeKey(null);
      }
    },
    [refresh, setError],
  );

  const removeLyricsScope = useCallback(
    async (rootId: string, relativePath: string) => {
      setError(null);
      try {
        await libraryStore.removeLyricsScope(rootId, relativePath);
        // A lyrics-only root (granted via addLyricsFolder's own
        // requestRoot('lyrics') - see GrantedRoot.kind's doc) has no other
        // reason to stay granted once its last scope is removed - revoke
        // it too rather than leave an orphaned grant sitting around
        // forever with nothing in the UI ever referencing it again. A
        // root still used for music, or still holding another lyrics
        // scope, is left alone.
        const isLibraryRoot = grantedRoots.some((r) => r.id === rootId && (r.kind ?? 'library') === 'library');
        const remainingScopes = await libraryStore.getLyricsScopes();
        if (!isLibraryRoot && !remainingScopes.some((s) => s.rootId === rootId)) {
          await fileAccess.revokeRoot(rootId);
        }
        await refresh();
        logLibraryAction('removeLyricsScope', { rootId, relativePath });
      } catch (err) {
        setError(errorMessage(err));
        logLibraryAction('removeLyricsScope:failed', { rootId, relativePath, error: String(err) });
      }
    },
    [fileAccess, libraryStore, grantedRoots, refresh, setError],
  );

  return { addFolder, rescan, removeRoot, addLyricsFolder, rescanLyricsScope, removeLyricsScope, busyRootId, busyLyricsScopeKey };
}

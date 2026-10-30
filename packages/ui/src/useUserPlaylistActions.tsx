import { createUserPlaylistAndOpen, deleteOpenUserPlaylist, renameOpenUserPlaylist } from '@bpmix/core';
import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useAppDispatch } from './store/hooks';
import { TextPromptDialog } from './TextPromptDialog';
import type { Colors } from './theme';

export interface UseUserPlaylistActionsResult {
  /** Asks for a name, then creates the playlist and opens it. */
  startCreate: (callbacks?: { onOpened?: (playlist: import('@bpmix/core').PlaylistRecord, rootId: string) => void }) => void;
  startRename: (currentName: string) => void;
  startDelete: (name: string) => void;
  /** The dialogs, to render once near the screen's root. Null when none is open. */
  dialogs: ReactNode;
}

/**
 * The prompts for building your own playlists (server mode): "New playlist" asks for a name, rename asks
 * for a new one, delete asks to confirm. The edits themselves are thunks in core, applied locally at once
 * and queued for the server; this only owns which dialog is showing.
 */
export function useUserPlaylistActions(colors: Colors): UseUserPlaylistActionsResult {
  const dispatch = useAppDispatch();
  const [dialog, setDialog] = useState<
    | { kind: 'create'; onOpened?: (playlist: import('@bpmix/core').PlaylistRecord, rootId: string) => void }
    | { kind: 'rename'; currentName: string }
    | { kind: 'delete'; name: string }
    | null
  >(null);

  const close = useCallback(() => setDialog(null), []);
  const startCreate = useCallback<UseUserPlaylistActionsResult['startCreate']>((callbacks) => setDialog({ kind: 'create', onOpened: callbacks?.onOpened }), []);
  const startRename = useCallback((currentName: string) => setDialog({ kind: 'rename', currentName }), []);
  const startDelete = useCallback((name: string) => setDialog({ kind: 'delete', name }), []);

  let dialogs: ReactNode = null;
  if (dialog?.kind === 'create') {
    dialogs = (
      <TextPromptDialog
        colors={colors}
        title="New playlist"
        placeholder="Playlist name"
        confirmLabel="Create"
        onCancel={close}
        onConfirm={(name) => {
          close();
          void dispatch(createUserPlaylistAndOpen(name, [], { onOpened: dialog.onOpened }));
        }}
      />
    );
  } else if (dialog?.kind === 'rename') {
    dialogs = (
      <TextPromptDialog
        colors={colors}
        title="Rename playlist"
        initialValue={dialog.currentName}
        confirmLabel="Rename"
        onCancel={close}
        onConfirm={(name) => {
          close();
          void dispatch(renameOpenUserPlaylist(name));
        }}
      />
    );
  } else if (dialog?.kind === 'delete') {
    dialogs = (
      <ConfirmDialog
        colors={colors}
        title="Delete playlist?"
        message={`"${dialog.name}" will be deleted from your account, on every device. The songs in it are not deleted.`}
        confirmLabel="Delete"
        onCancel={close}
        onConfirm={() => {
          close();
          void dispatch(deleteOpenUserPlaylist());
        }}
      />
    );
  }

  return { startCreate, startRename, startDelete, dialogs };
}

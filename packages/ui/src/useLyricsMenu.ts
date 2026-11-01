import { errorMessage, type ServerMode } from '@beatseam/core';
import { useCallback, useMemo } from 'react';
import type { LyricsMenu } from './HeaderActions';
import type { NotificationCenter } from './notifications/useNotificationCenter';

export interface UseLyricsMenuOptions {
  /** The current track's file id, or null/undefined with nothing loaded. */
  currentFileId: string | null | undefined;
  hasLyrics: boolean;
  /** The lyrics come from a server rather than the device's own folders. */
  fromServer: boolean;
  /** Whether the person may change the shared library's lyrics (a server admin); irrelevant off a server. */
  canEdit: boolean;
  serverMode: ServerMode | undefined;
  center: NotificationCenter;
  onOpenEditor: () => void;
  onChangeFile: () => void;
}

/**
 * What the header's lyrics dropdown offers for the playing track, shared by the apps' headers. Off a
 * server, the person edits their own files. On one, only admins change the shared lyrics, and everyone
 * can report them as wrong for an admin to look at. Undefined (no dropdown) when nothing is playing or
 * the track has no lyrics.
 */
export function useLyricsMenu({ currentFileId, hasLyrics, fromServer, canEdit, serverMode, center, onOpenEditor, onChangeFile }: UseLyricsMenuOptions): LyricsMenu | undefined {
  const { addError, upsertProgress } = center;
  const onReport = useCallback(() => {
    if (!currentFileId || !serverMode) return;
    serverMode.reportLyrics(currentFileId).then(
      () => upsertProgress('lyrics-report', 'Lyrics reported', 1, 1, true, 'An admin will take a look at them.'),
      (err: unknown) => addError("Couldn't report the lyrics", errorMessage(err)),
    );
  }, [currentFileId, serverMode, addError, upsertProgress]);

  return useMemo(() => {
    if (!currentFileId || !hasLyrics) return undefined;
    const mayChange = !fromServer || canEdit;
    return {
      onOpenEditor: mayChange ? onOpenEditor : undefined,
      onChangeFile: mayChange ? onChangeFile : undefined,
      onReport: fromServer ? onReport : undefined,
    };
  }, [currentFileId, hasLyrics, fromServer, canEdit, onOpenEditor, onChangeFile, onReport]);
}

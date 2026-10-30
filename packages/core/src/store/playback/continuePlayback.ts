import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import type { RemotePlayback } from '../../server-mode/devicePlayback';
import { playingContextSet, toPlaylistContext } from '../navigation/navigationSlice';
import { playbackPatched } from '../persistence/persistenceSlice';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';

type AppThunk<R> = ThunkAction<R, RootState, Services, UnknownAction>;

/**
 * Starts what another of the person's devices was playing - the same playlist, track and position,
 * with its loop and shuffle settings - on this one, and plays it. Everything is read from the synced
 * library in local storage, so it works without waiting on the network (the audio itself streams, or is
 * already downloaded). Resolves false if that playlist or track isn't in this device's library (not
 * synced yet, or since removed), in which case nothing is touched.
 */
export function continuePlayback(remote: RemotePlayback): AppThunk<Promise<boolean>> {
  return async (dispatch, _getState, { fileAccess, libraryStore, playlistPlayer, livePlayback }) => {
    const roots = await fileAccess.listGrantedRoots();
    let found: { rootId: string; playlistId: string; trackFileIds: string[] } | null = null;
    // The root the other device named first, then the rest (it may have been a different view of the same library).
    for (const root of [...roots].sort((a) => (a.id === remote.rootId ? -1 : 1))) {
      const playlist = (await libraryStore.listPlaylists(root.id)).find((p) => p.id === remote.playlistId);
      if (playlist?.trackFileIds.includes(remote.currentTrackFileId)) {
        found = { rootId: root.id, playlistId: playlist.id, trackFileIds: playlist.trackFileIds };
        break;
      }
    }
    if (!found) return false;
    const root = roots.find((r) => r.id === found!.rootId)!;
    const playlist = (await libraryStore.listPlaylists(root.id)).find((p) => p.id === found!.playlistId)!;
    const tracksById = new Map((await libraryStore.listTracks(root.id)).map((t) => [t.fileId, t]));
    if (!tracksById.has(remote.currentTrackFileId)) return false;

    // Before the player loads: it resolves tracks through the playing context, possibly synchronously.
    dispatch(playingContextSet(toPlaylistContext(root, playlist, tracksById)));
    playlistPlayer.setShuffle(remote.shuffleEnabled);
    playlistPlayer.setLoopMode(remote.loopMode);
    await playlistPlayer.setPlaylist(playlist.trackFileIds, remote.currentTrackFileId, { playlistId: playlist.id });
    if (remote.positionSeconds > 1) playlistPlayer.seek(remote.positionSeconds);
    livePlayback.publish();
    dispatch(
      playbackPatched({
        patch: {
          playlistId: playlist.id,
          rootId: root.id,
          currentTrackFileId: remote.currentTrackFileId,
          positionSeconds: remote.positionSeconds,
          loopMode: remote.loopMode,
          shuffleEnabled: remote.shuffleEnabled,
          shuffleOrder: playlistPlayer.getShuffleOrder(),
        },
      }),
    );
    return true;
  };
}

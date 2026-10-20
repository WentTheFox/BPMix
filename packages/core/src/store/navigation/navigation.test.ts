import { describe, expect, it } from 'vitest';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import {
  createPlaylistEnded,
  createPlaylistFolderChosen,
  createPlaylistStarted,
  externalConnectionsOpened,
  lyricsEditorOpenedFromMenu,
  lyricsPickerOpenedFromMenu,
  nowPlayingOpenChanged,
  settingsClosed,
  settingsOpened,
} from './navigationSlice';

const makeStore = () => createStore({ livePlayback: fakeLivePlayback().live } as unknown as Services);

describe('navigation slice', () => {
  it('starts with everything closed', () => {
    expect(makeStore().getState().navigation).toEqual({
      settingsOpen: false,
      externalConnectionsOpen: false,
      nowPlayingOpen: false,
      lyricsEditorOpen: false,
      lyricsPickerOpen: false,
      createPlaylistRootId: null,
      createPlaylistTarget: null,
      screen: { kind: 'library' },
      playingContext: null,
      editingPlaylistFile: null,
      addToPlaylistTrack: null,
      isFindingUnplaylisted: false,
      unplaylistedRequestId: 0,
    });
  });

  it('closing Settings also closes its External connections sub-screen', () => {
    const store = makeStore();
    store.dispatch(settingsOpened());
    store.dispatch(externalConnectionsOpened());
    store.dispatch(settingsClosed());
    expect(store.getState().navigation).toMatchObject({ settingsOpen: false, externalConnectionsOpen: false });
  });

  it('opening the lyrics editor/picker from the menu also opens Now Playing', () => {
    const editor = makeStore();
    editor.dispatch(lyricsEditorOpenedFromMenu());
    expect(editor.getState().navigation).toMatchObject({ lyricsEditorOpen: true, nowPlayingOpen: true, lyricsPickerOpen: false });

    const picker = makeStore();
    picker.dispatch(lyricsPickerOpenedFromMenu());
    expect(picker.getState().navigation).toMatchObject({ lyricsPickerOpen: true, nowPlayingOpen: true, lyricsEditorOpen: false });
  });

  it('closing Now Playing leaves the lyrics flags alone', () => {
    const store = makeStore();
    store.dispatch(lyricsEditorOpenedFromMenu());
    store.dispatch(nowPlayingOpenChanged(false));
    expect(store.getState().navigation).toMatchObject({ nowPlayingOpen: false, lyricsEditorOpen: true });
  });

  it('walks the create-playlist flow: pick root, choose folder, end', () => {
    const store = makeStore();
    store.dispatch(createPlaylistStarted('root1'));
    expect(store.getState().navigation.createPlaylistRootId).toBe('root1');

    const target = { rootId: 'root1', folderRelativePath: 'Album', folderDisplayName: 'Music/Album' };
    store.dispatch(createPlaylistFolderChosen(target));
    expect(store.getState().navigation).toMatchObject({ createPlaylistRootId: null, createPlaylistTarget: target });

    store.dispatch(createPlaylistEnded());
    expect(store.getState().navigation).toMatchObject({ createPlaylistRootId: null, createPlaylistTarget: null });
  });

  it('cancelling the folder browser (step 1) ends the flow', () => {
    const store = makeStore();
    store.dispatch(createPlaylistStarted('root1'));
    store.dispatch(createPlaylistEnded());
    expect(store.getState().navigation.createPlaylistRootId).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import { settingsUpdated } from './settingsSlice';
import { loadSettings, resetSettings } from './settingsThunks';
import {
  ACCENT_COLOR_SETTING_KEY,
  CROSSFADE_SECONDS_SETTING_KEY,
  LASTFM_SESSION_KEY_SETTING_KEY,
  THEME_MODE_SETTING_KEY,
  VOLUME_NORMALIZATION_SETTING_KEY,
} from './settingsStorage';

function makeStore(initial: Record<string, string> = {}) {
  const db = new Map(Object.entries(initial));
  const libraryStore = {
    getSetting: vi.fn(async (key: string) => db.get(key) ?? null),
    putSetting: vi.fn(async (key: string, value: string) => {
      db.set(key, value);
    }),
  };
  const playlistPlayer = { setCrossfadeSeconds: vi.fn() };
  const store = createStore({ libraryStore, playlistPlayer, livePlayback: fakeLivePlayback().live } as unknown as Services);
  return { store, libraryStore, db, playlistPlayer };
}

describe('settings slice', () => {
  it('starts unloaded with defaults', () => {
    const { store } = makeStore();
    expect(store.getState().settings.loaded).toBe(false);
    expect(store.getState().settings.values.crossfadeSeconds).toBe(8);
  });

  it('hydrates stored values and falls back to the system theme on first run', async () => {
    const { store } = makeStore({ [CROSSFADE_SECONDS_SETTING_KEY]: '12', [VOLUME_NORMALIZATION_SETTING_KEY]: '0' });
    await store.dispatch(loadSettings('dark'));
    const { values, loaded } = store.getState().settings;
    expect(loaded).toBe(true);
    expect(values.crossfadeSeconds).toBe(12);
    expect(values.volumeNormalizationEnabled).toBe(false);
    expect(values.themeMode).toBe('dark');
  });

  it('prefers a stored theme over the system one, and ignores an invalid stored theme', async () => {
    const stored = makeStore({ [THEME_MODE_SETTING_KEY]: 'amoled' });
    await stored.store.dispatch(loadSettings('light'));
    expect(stored.store.getState().settings.values.themeMode).toBe('amoled');

    const invalid = makeStore({ [THEME_MODE_SETTING_KEY]: 'bogus' });
    await invalid.store.dispatch(loadSettings('dark'));
    expect(invalid.store.getState().settings.values.themeMode).toBe('dark');
  });

  it('maps a legacy raw hex accent color to its preset id, and unknown values to the default', async () => {
    const legacy = makeStore({ [ACCENT_COLOR_SETTING_KEY]: '#C15C5C' });
    await legacy.store.dispatch(loadSettings('light'));
    expect(legacy.store.getState().settings.values.accentColor).toBe('red');

    const unknown = makeStore({ [ACCENT_COLOR_SETTING_KEY]: 'nonsense' });
    await unknown.store.dispatch(loadSettings('light'));
    expect(unknown.store.getState().settings.values.accentColor).toBe('glaucous');
  });

  it('does not write back what it just loaded', async () => {
    const { store, libraryStore } = makeStore({ [CROSSFADE_SECONDS_SETTING_KEY]: '12' });
    await store.dispatch(loadSettings('light'));
    expect(libraryStore.putSetting).not.toHaveBeenCalled();
  });

  it('persists only the patched keys, serialized, when settings are updated', () => {
    const { store, libraryStore } = makeStore();
    store.dispatch(settingsUpdated({ crossfadeSeconds: 5, lyricsEnabled: false, lastFmSessionKey: null }));
    expect(store.getState().settings.values.crossfadeSeconds).toBe(5);
    expect(libraryStore.putSetting).toHaveBeenCalledWith(CROSSFADE_SECONDS_SETTING_KEY, '5');
    expect(libraryStore.putSetting).toHaveBeenCalledWith('settings.lyricsEnabled', '0');
    // A null session key (disconnect) is stored as '' - same as before.
    expect(libraryStore.putSetting).toHaveBeenCalledWith(LASTFM_SESSION_KEY_SETTING_KEY, '');
    expect(libraryStore.putSetting).toHaveBeenCalledTimes(3);
  });

  it('pushes the crossfade length into the player on hydration and when it changes, but not for other settings', async () => {
    const { store, playlistPlayer } = makeStore({ [CROSSFADE_SECONDS_SETTING_KEY]: '12' });
    await store.dispatch(loadSettings('light'));
    expect(playlistPlayer.setCrossfadeSeconds).toHaveBeenLastCalledWith(12);
    store.dispatch(settingsUpdated({ crossfadeSeconds: 3 }));
    expect(playlistPlayer.setCrossfadeSeconds).toHaveBeenLastCalledWith(3);
    playlistPlayer.setCrossfadeSeconds.mockClear();
    store.dispatch(settingsUpdated({ lyricsEnabled: false }));
    expect(playlistPlayer.setCrossfadeSeconds).not.toHaveBeenCalled();
  });

  it('reset restores preferences but leaves Last.fm credentials alone', async () => {
    const { store, libraryStore } = makeStore();
    await store.dispatch(loadSettings('light'));
    store.dispatch(settingsUpdated({ crossfadeSeconds: 20, lastFmSessionKey: 'sk', lastFmUsername: 'me', themeMode: 'amoled' }));
    libraryStore.putSetting.mockClear();

    store.dispatch(resetSettings('dark'));

    const { values } = store.getState().settings;
    expect(values.crossfadeSeconds).toBe(8);
    expect(values.themeMode).toBe('dark');
    expect(values.lastFmSessionKey).toBe('sk');
    expect(values.lastFmUsername).toBe('me');
    const writtenKeys = libraryStore.putSetting.mock.calls.map(([key]) => key);
    expect(writtenKeys.some((key) => key.includes('lastFm'))).toBe(false);
  });
});

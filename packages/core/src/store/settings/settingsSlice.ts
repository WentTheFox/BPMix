import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { DEFAULT_LASTFM_API_KEY, DEFAULT_LASTFM_API_SECRET } from '../../scrobble/lastfm';
import { parseStoredSettings } from './settingsStorage';
import type { StoredSettings } from './settingsStorage';
import { DEFAULT_ACCENT_COLOR_ID } from './types';
import type { AppSettings, ThemeMode } from './types';

export const DEFAULT_VOLUME_NORMALIZATION_ENABLED = true;
export const DEFAULT_CROSSFADE_SECONDS = 8;
export const DEFAULT_LYRICS_ENABLED = true;
export const DEFAULT_SHOW_VOLUME_BUTTON_ON_NOW_PLAYING = true;
export const DEFAULT_DISCORD_RICH_PRESENCE_ENABLED = true;

export interface SettingsState {
  values: AppSettings;
  /** False until the initial read from LibraryStore resolves - `values` holds defaults until then. */
  loaded: boolean;
}

export const initialSettings: AppSettings = {
  // The real first-run default is the system color scheme, which only the UI
  // knows - hydration (settingsLoaded) supplies it.
  themeMode: 'light',
  accentColor: DEFAULT_ACCENT_COLOR_ID,
  volumeNormalizationEnabled: DEFAULT_VOLUME_NORMALIZATION_ENABLED,
  crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
  lyricsEnabled: DEFAULT_LYRICS_ENABLED,
  showVolumeButtonOnNowPlaying: DEFAULT_SHOW_VOLUME_BUTTON_ON_NOW_PLAYING,
  lastFmApiKey: DEFAULT_LASTFM_API_KEY,
  lastFmApiSecret: DEFAULT_LASTFM_API_SECRET,
  lastFmSessionKey: null,
  lastFmUsername: null,
  discordRichPresenceEnabled: DEFAULT_DISCORD_RICH_PRESENCE_ENABLED,
};

const initialState: SettingsState = { values: initialSettings, loaded: false };

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    /** Initial read from storage finished. Not persisted back (it came from storage). */
    settingsLoaded(state, action: PayloadAction<{ stored: StoredSettings; systemThemeMode: ThemeMode }>) {
      state.values = parseStoredSettings(action.payload.stored, {
        ...state.values,
        themeMode: action.payload.systemThemeMode,
      });
      state.loaded = true;
    },
    /** A user/auth-flow change. The persistence listener writes the patched keys through LibraryStore. */
    settingsUpdated(state, action: PayloadAction<Partial<AppSettings>>) {
      state.values = { ...state.values, ...action.payload };
    },
  },
});

export const { settingsLoaded, settingsUpdated } = settingsSlice.actions;

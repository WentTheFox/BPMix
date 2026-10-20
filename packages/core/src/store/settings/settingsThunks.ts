import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import {
  DEFAULT_DISCORD_RICH_PRESENCE_ENABLED,
  DEFAULT_CROSSFADE_SECONDS,
  DEFAULT_LYRICS_ENABLED,
  DEFAULT_SHOW_VOLUME_BUTTON_ON_NOW_PLAYING,
  DEFAULT_VOLUME_NORMALIZATION_ENABLED,
  settingsLoaded,
  settingsUpdated,
} from './settingsSlice';
import { ALL_SETTING_KEYS } from './settingsStorage';
import type { StoredSettings } from './settingsStorage';
import { DEFAULT_ACCENT_COLOR_ID } from './types';
import type { ThemeMode } from './types';

type AppThunk<R = void> = ThunkAction<R, RootState, Services, UnknownAction>;

/** Reads every persisted setting and hydrates the slice. `systemThemeMode` is the first-run themeMode default (nothing stored yet). */
export function loadSettings(systemThemeMode: ThemeMode): AppThunk<Promise<void>> {
  return async (dispatch, _getState, { libraryStore }) => {
    const values = await Promise.all(ALL_SETTING_KEYS.map((key) => libraryStore.getSetting(key)));
    const stored: StoredSettings = {};
    ALL_SETTING_KEYS.forEach((key, i) => {
      stored[key] = values[i] ?? null;
    });
    dispatch(settingsLoaded({ stored, systemThemeMode }));
  };
}

/**
 * Deliberately leaves lastFmApiKey/lastFmApiSecret/lastFmSessionKey/
 * lastFmUsername untouched - Last.fm's connection is a separate
 * integration credential, not an appearance/playback preference, and
 * SettingsScreen's reset-confirm dialog only promises to reset the fields
 * listed below. Disconnecting Last.fm has its own explicit "Disconnect"
 * action instead.
 */
export function resetSettings(systemThemeMode: ThemeMode): AppThunk {
  return (dispatch) => {
    dispatch(
      settingsUpdated({
        themeMode: systemThemeMode,
        accentColor: DEFAULT_ACCENT_COLOR_ID,
        volumeNormalizationEnabled: DEFAULT_VOLUME_NORMALIZATION_ENABLED,
        crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
        lyricsEnabled: DEFAULT_LYRICS_ENABLED,
        showVolumeButtonOnNowPlaying: DEFAULT_SHOW_VOLUME_BUTTON_ON_NOW_PLAYING,
        discordRichPresenceEnabled: DEFAULT_DISCORD_RICH_PRESENCE_ENABLED,
      }),
    );
  };
}

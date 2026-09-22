import type { LibraryStore } from '@bpmix/core';
import { DEFAULT_LASTFM_API_KEY, DEFAULT_LASTFM_API_SECRET } from '@bpmix/core';
import { useCallback, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import type { ThemeMode } from '../theme';
import { ACCENT_COLOR_OPTIONS, DEFAULT_ACCENT_COLOR_ID } from './types';
import type { AppSettings } from './types';

export const THEME_MODE_SETTING_KEY = 'settings.themeMode';
export const ACCENT_COLOR_SETTING_KEY = 'settings.accentColor';
export const VOLUME_NORMALIZATION_SETTING_KEY = 'settings.volumeNormalizationEnabled';
export const CROSSFADE_SECONDS_SETTING_KEY = 'settings.crossfadeSeconds';
export const LYRICS_ENABLED_SETTING_KEY = 'settings.lyricsEnabled';
export const SHOW_VOLUME_BUTTON_ON_NOW_PLAYING_SETTING_KEY = 'settings.showVolumeButtonOnNowPlaying';
export const LASTFM_API_KEY_SETTING_KEY = 'settings.lastFmApiKey';
export const LASTFM_API_SECRET_SETTING_KEY = 'settings.lastFmApiSecret';
export const LASTFM_SESSION_KEY_SETTING_KEY = 'settings.lastFmSessionKey';
export const LASTFM_USERNAME_SETTING_KEY = 'settings.lastFmUsername';
export const DISCORD_RICH_PRESENCE_ENABLED_SETTING_KEY = 'settings.discordRichPresenceEnabled';

const DEFAULT_VOLUME_NORMALIZATION_ENABLED = true;
const DEFAULT_CROSSFADE_SECONDS = 8;
const DEFAULT_LYRICS_ENABLED = true;
const DEFAULT_SHOW_VOLUME_BUTTON_ON_NOW_PLAYING = true;
const DEFAULT_DISCORD_RICH_PRESENCE_ENABLED = true;

function isThemeMode(value: string): value is ThemeMode {
  return value === 'light' || value === 'flux' || value === 'dark' || value === 'amoled';
}

/** Accepts a known accentColor id as-is. A value that isn't one - either unrecognized, or (pre-migration) a raw hex string from before accentColor became an id - maps to the closest known id by hex match, or the default if even that fails, so an old install's saved color choice still resolves to a real swatch instead of silently falling back to the default on every launch. */
function normalizeAccentColorId(value: string): string {
  if (ACCENT_COLOR_OPTIONS.some((option) => option.id === value)) return value;
  const byHex = ACCENT_COLOR_OPTIONS.find((option) => option.hex.toLowerCase() === value.toLowerCase());
  return byHex?.id ?? DEFAULT_ACCENT_COLOR_ID;
}

export interface UseAppSettingsResult {
  settings: AppSettings;
  /** False until the initial read from `libraryStore` resolves - `settings` holds defaults until then, same pattern as the rest of the app's restore-on-launch state. */
  loaded: boolean;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

/**
 * Backed by LibraryStore's generic settings key/value store (see its
 * getSetting/putSetting doc), the same store the app already uses for the
 * lyrics-match count and install-onboarding dismissal. `themeMode` defaults
 * to the current system color scheme rather than a fixed light/dark the
 * first time this ever loads (nothing stored yet), so an existing install
 * keeps looking the way it always has until someone opens Settings and
 * picks a mode explicitly.
 */
export function useAppSettings(libraryStore: LibraryStore): UseAppSettingsResult {
  const systemScheme = useColorScheme();
  const [settings, setSettings] = useState<AppSettings>(() => ({
    themeMode: systemScheme === 'dark' ? 'dark' : 'light',
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
  }));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [
        themeMode,
        accentColor,
        volumeNormalization,
        crossfadeSeconds,
        lyricsEnabled,
        showVolumeButtonOnNowPlaying,
        lastFmApiKey,
        lastFmApiSecret,
        lastFmSessionKey,
        lastFmUsername,
        discordRichPresenceEnabled,
      ] = await Promise.all([
        libraryStore.getSetting(THEME_MODE_SETTING_KEY),
        libraryStore.getSetting(ACCENT_COLOR_SETTING_KEY),
        libraryStore.getSetting(VOLUME_NORMALIZATION_SETTING_KEY),
        libraryStore.getSetting(CROSSFADE_SECONDS_SETTING_KEY),
        libraryStore.getSetting(LYRICS_ENABLED_SETTING_KEY),
        libraryStore.getSetting(SHOW_VOLUME_BUTTON_ON_NOW_PLAYING_SETTING_KEY),
        libraryStore.getSetting(LASTFM_API_KEY_SETTING_KEY),
        libraryStore.getSetting(LASTFM_API_SECRET_SETTING_KEY),
        libraryStore.getSetting(LASTFM_SESSION_KEY_SETTING_KEY),
        libraryStore.getSetting(LASTFM_USERNAME_SETTING_KEY),
        libraryStore.getSetting(DISCORD_RICH_PRESENCE_ENABLED_SETTING_KEY),
      ]);
      if (cancelled) return;
      setSettings((prev) => ({
        themeMode: themeMode && isThemeMode(themeMode) ? themeMode : prev.themeMode,
        accentColor: accentColor ? normalizeAccentColorId(accentColor) : prev.accentColor,
        volumeNormalizationEnabled: volumeNormalization === null ? prev.volumeNormalizationEnabled : volumeNormalization === '1',
        crossfadeSeconds: crossfadeSeconds ? Number(crossfadeSeconds) : prev.crossfadeSeconds,
        lyricsEnabled: lyricsEnabled === null ? prev.lyricsEnabled : lyricsEnabled === '1',
        showVolumeButtonOnNowPlaying: showVolumeButtonOnNowPlaying === null ? prev.showVolumeButtonOnNowPlaying : showVolumeButtonOnNowPlaying === '1',
        lastFmApiKey: lastFmApiKey ?? prev.lastFmApiKey,
        lastFmApiSecret: lastFmApiSecret ?? prev.lastFmApiSecret,
        lastFmSessionKey: lastFmSessionKey ?? prev.lastFmSessionKey,
        lastFmUsername: lastFmUsername ?? prev.lastFmUsername,
        discordRichPresenceEnabled: discordRichPresenceEnabled === null ? prev.discordRichPresenceEnabled : discordRichPresenceEnabled === '1',
      }));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // libraryStore is a stable module-level singleton in both apps, not a
    // value that changes across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => ({ ...prev, ...patch }));
      if (patch.themeMode !== undefined) void libraryStore.putSetting(THEME_MODE_SETTING_KEY, patch.themeMode);
      if (patch.accentColor !== undefined) void libraryStore.putSetting(ACCENT_COLOR_SETTING_KEY, patch.accentColor);
      if (patch.volumeNormalizationEnabled !== undefined) {
        void libraryStore.putSetting(VOLUME_NORMALIZATION_SETTING_KEY, patch.volumeNormalizationEnabled ? '1' : '0');
      }
      if (patch.crossfadeSeconds !== undefined) void libraryStore.putSetting(CROSSFADE_SECONDS_SETTING_KEY, String(patch.crossfadeSeconds));
      if (patch.lyricsEnabled !== undefined) void libraryStore.putSetting(LYRICS_ENABLED_SETTING_KEY, patch.lyricsEnabled ? '1' : '0');
      if (patch.showVolumeButtonOnNowPlaying !== undefined) {
        void libraryStore.putSetting(SHOW_VOLUME_BUTTON_ON_NOW_PLAYING_SETTING_KEY, patch.showVolumeButtonOnNowPlaying ? '1' : '0');
      }
      if (patch.lastFmApiKey !== undefined) void libraryStore.putSetting(LASTFM_API_KEY_SETTING_KEY, patch.lastFmApiKey);
      if (patch.lastFmApiSecret !== undefined) void libraryStore.putSetting(LASTFM_API_SECRET_SETTING_KEY, patch.lastFmApiSecret);
      if (patch.lastFmSessionKey !== undefined) void libraryStore.putSetting(LASTFM_SESSION_KEY_SETTING_KEY, patch.lastFmSessionKey ?? '');
      if (patch.lastFmUsername !== undefined) void libraryStore.putSetting(LASTFM_USERNAME_SETTING_KEY, patch.lastFmUsername ?? '');
      if (patch.discordRichPresenceEnabled !== undefined) {
        void libraryStore.putSetting(DISCORD_RICH_PRESENCE_ENABLED_SETTING_KEY, patch.discordRichPresenceEnabled ? '1' : '0');
      }
    },
    [libraryStore],
  );

  // Deliberately leaves lastFmApiKey/lastFmApiSecret/lastFmSessionKey/
  // lastFmUsername untouched - Last.fm's connection is a separate
  // integration credential, not an appearance/playback preference, and
  // ConfirmResetOpen's own dialog text (SettingsScreen) only promises to
  // reset the fields listed below. Disconnecting Last.fm has its own
  // explicit "Disconnect" action instead.
  const resetSettings = useCallback(() => {
    updateSettings({
      themeMode: systemScheme === 'dark' ? 'dark' : 'light',
      accentColor: DEFAULT_ACCENT_COLOR_ID,
      volumeNormalizationEnabled: DEFAULT_VOLUME_NORMALIZATION_ENABLED,
      crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
      lyricsEnabled: DEFAULT_LYRICS_ENABLED,
      showVolumeButtonOnNowPlaying: DEFAULT_SHOW_VOLUME_BUTTON_ON_NOW_PLAYING,
      discordRichPresenceEnabled: DEFAULT_DISCORD_RICH_PRESENCE_ENABLED,
    });
  }, [systemScheme, updateSettings]);

  return { settings, loaded, updateSettings, resetSettings };
}

import type { AppSettings, ThemeMode } from './types';
import { ACCENT_COLOR_OPTIONS, DEFAULT_ACCENT_COLOR_ID } from './types';

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

/** Raw string values (or null if never stored) read back from LibraryStore.getSetting, keyed by storage key. */
export type StoredSettings = Record<string, string | null>;

export const ALL_SETTING_KEYS = [
  THEME_MODE_SETTING_KEY,
  ACCENT_COLOR_SETTING_KEY,
  VOLUME_NORMALIZATION_SETTING_KEY,
  CROSSFADE_SECONDS_SETTING_KEY,
  LYRICS_ENABLED_SETTING_KEY,
  SHOW_VOLUME_BUTTON_ON_NOW_PLAYING_SETTING_KEY,
  LASTFM_API_KEY_SETTING_KEY,
  LASTFM_API_SECRET_SETTING_KEY,
  LASTFM_SESSION_KEY_SETTING_KEY,
  LASTFM_USERNAME_SETTING_KEY,
  DISCORD_RICH_PRESENCE_ENABLED_SETTING_KEY,
];

function isThemeMode(value: string): value is ThemeMode {
  return value === 'light' || value === 'flux' || value === 'dark' || value === 'amoled';
}

/** Accepts a known accentColor id as-is. A value that isn't one - either unrecognized, or (pre-migration) a raw hex string from before accentColor became an id - maps to the closest known id by hex match, or the default if even that fails, so an old install's saved color choice still resolves to a real swatch instead of silently falling back to the default on every launch. */
export function normalizeAccentColorId(value: string): string {
  if (ACCENT_COLOR_OPTIONS.some((option) => option.id === value)) return value;
  const byHex = ACCENT_COLOR_OPTIONS.find((option) => option.hex.toLowerCase() === value.toLowerCase());
  return byHex?.id ?? DEFAULT_ACCENT_COLOR_ID;
}

/** Overlays whatever was stored on `base`; a key never stored (null) keeps `base`'s value. */
export function parseStoredSettings(stored: StoredSettings, base: AppSettings): AppSettings {
  const themeMode = stored[THEME_MODE_SETTING_KEY];
  const accentColor = stored[ACCENT_COLOR_SETTING_KEY];
  const volumeNormalization = stored[VOLUME_NORMALIZATION_SETTING_KEY];
  const crossfadeSeconds = stored[CROSSFADE_SECONDS_SETTING_KEY];
  const lyricsEnabled = stored[LYRICS_ENABLED_SETTING_KEY];
  const showVolumeButton = stored[SHOW_VOLUME_BUTTON_ON_NOW_PLAYING_SETTING_KEY];
  const discord = stored[DISCORD_RICH_PRESENCE_ENABLED_SETTING_KEY];
  return {
    themeMode: themeMode && isThemeMode(themeMode) ? themeMode : base.themeMode,
    accentColor: accentColor ? normalizeAccentColorId(accentColor) : base.accentColor,
    volumeNormalizationEnabled: volumeNormalization == null ? base.volumeNormalizationEnabled : volumeNormalization === '1',
    crossfadeSeconds: crossfadeSeconds ? Number(crossfadeSeconds) : base.crossfadeSeconds,
    lyricsEnabled: lyricsEnabled == null ? base.lyricsEnabled : lyricsEnabled === '1',
    showVolumeButtonOnNowPlaying: showVolumeButton == null ? base.showVolumeButtonOnNowPlaying : showVolumeButton === '1',
    lastFmApiKey: stored[LASTFM_API_KEY_SETTING_KEY] ?? base.lastFmApiKey,
    lastFmApiSecret: stored[LASTFM_API_SECRET_SETTING_KEY] ?? base.lastFmApiSecret,
    lastFmSessionKey: stored[LASTFM_SESSION_KEY_SETTING_KEY] ?? base.lastFmSessionKey,
    lastFmUsername: stored[LASTFM_USERNAME_SETTING_KEY] ?? base.lastFmUsername,
    discordRichPresenceEnabled: discord == null ? base.discordRichPresenceEnabled : discord === '1',
  };
}

/** The [storage key, serialized value] writes a settings patch implies - only the fields the patch actually sets. */
export function serializeSettingsPatch(patch: Partial<AppSettings>): Array<[string, string]> {
  const writes: Array<[string, string]> = [];
  if (patch.themeMode !== undefined) writes.push([THEME_MODE_SETTING_KEY, patch.themeMode]);
  if (patch.accentColor !== undefined) writes.push([ACCENT_COLOR_SETTING_KEY, patch.accentColor]);
  if (patch.volumeNormalizationEnabled !== undefined) {
    writes.push([VOLUME_NORMALIZATION_SETTING_KEY, patch.volumeNormalizationEnabled ? '1' : '0']);
  }
  if (patch.crossfadeSeconds !== undefined) writes.push([CROSSFADE_SECONDS_SETTING_KEY, String(patch.crossfadeSeconds)]);
  if (patch.lyricsEnabled !== undefined) writes.push([LYRICS_ENABLED_SETTING_KEY, patch.lyricsEnabled ? '1' : '0']);
  if (patch.showVolumeButtonOnNowPlaying !== undefined) {
    writes.push([SHOW_VOLUME_BUTTON_ON_NOW_PLAYING_SETTING_KEY, patch.showVolumeButtonOnNowPlaying ? '1' : '0']);
  }
  if (patch.lastFmApiKey !== undefined) writes.push([LASTFM_API_KEY_SETTING_KEY, patch.lastFmApiKey]);
  if (patch.lastFmApiSecret !== undefined) writes.push([LASTFM_API_SECRET_SETTING_KEY, patch.lastFmApiSecret]);
  if (patch.lastFmSessionKey !== undefined) writes.push([LASTFM_SESSION_KEY_SETTING_KEY, patch.lastFmSessionKey ?? '']);
  if (patch.lastFmUsername !== undefined) writes.push([LASTFM_USERNAME_SETTING_KEY, patch.lastFmUsername ?? '']);
  if (patch.discordRichPresenceEnabled !== undefined) {
    writes.push([DISCORD_RICH_PRESENCE_ENABLED_SETTING_KEY, patch.discordRichPresenceEnabled ? '1' : '0']);
  }
  return writes;
}

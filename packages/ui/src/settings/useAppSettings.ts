import type { LibraryStore } from '@bpmix/core';
import { useCallback, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import type { ThemeMode } from '../theme';
import { ACCENT_COLOR_OPTIONS, DEFAULT_ACCENT_COLOR_ID } from './types';
import type { AppSettings } from './types';

export const THEME_MODE_SETTING_KEY = 'settings.themeMode';
export const ACCENT_COLOR_SETTING_KEY = 'settings.accentColor';
export const VOLUME_NORMALIZATION_SETTING_KEY = 'settings.volumeNormalizationEnabled';
export const CROSSFADE_SECONDS_SETTING_KEY = 'settings.crossfadeSeconds';

const DEFAULT_VOLUME_NORMALIZATION_ENABLED = true;
const DEFAULT_CROSSFADE_SECONDS = 8;

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
  }));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [themeMode, accentColor, volumeNormalization, crossfadeSeconds] = await Promise.all([
        libraryStore.getSetting(THEME_MODE_SETTING_KEY),
        libraryStore.getSetting(ACCENT_COLOR_SETTING_KEY),
        libraryStore.getSetting(VOLUME_NORMALIZATION_SETTING_KEY),
        libraryStore.getSetting(CROSSFADE_SECONDS_SETTING_KEY),
      ]);
      if (cancelled) return;
      setSettings((prev) => ({
        themeMode: themeMode && isThemeMode(themeMode) ? themeMode : prev.themeMode,
        accentColor: accentColor ? normalizeAccentColorId(accentColor) : prev.accentColor,
        volumeNormalizationEnabled: volumeNormalization === null ? prev.volumeNormalizationEnabled : volumeNormalization === '1',
        crossfadeSeconds: crossfadeSeconds ? Number(crossfadeSeconds) : prev.crossfadeSeconds,
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
    },
    [libraryStore],
  );

  const resetSettings = useCallback(() => {
    updateSettings({
      themeMode: systemScheme === 'dark' ? 'dark' : 'light',
      accentColor: DEFAULT_ACCENT_COLOR_ID,
      volumeNormalizationEnabled: DEFAULT_VOLUME_NORMALIZATION_ENABLED,
      crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
    });
  }, [systemScheme, updateSettings]);

  return { settings, loaded, updateSettings, resetSettings };
}

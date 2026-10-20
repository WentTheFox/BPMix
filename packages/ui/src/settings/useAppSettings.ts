import { loadSettings, resetSettings as resetSettingsThunk, settingsUpdated } from '@bpmix/core';
import type { AppSettings, ThemeMode } from '@bpmix/core';
import { useCallback, useEffect, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { useAppDispatch, useAppSelector } from '../store/hooks';

export interface UseAppSettingsResult {
  settings: AppSettings;
  /** False until the initial read from storage resolves - `settings` holds defaults until then, same pattern as the rest of the app's restore-on-launch state. */
  loaded: boolean;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

/**
 * Thin view over the store's `settings` slice (see @bpmix/core's
 * store/settings): state, hydration, persistence and reset semantics all
 * live there. What stays here is the one thing only the UI knows - the
 * system color scheme, used as `themeMode`'s first-run default (nothing
 * stored yet), so an existing install keeps looking the way it always has
 * until someone opens Settings and picks a mode explicitly.
 */
export function useAppSettings(): UseAppSettingsResult {
  const systemScheme = useColorScheme();
  const systemThemeMode: ThemeMode = systemScheme === 'dark' ? 'dark' : 'light';
  const dispatch = useAppDispatch();
  const values = useAppSelector((state) => state.settings.values);
  const loaded = useAppSelector((state) => state.settings.loaded);

  useEffect(() => {
    void dispatch(loadSettings(systemThemeMode));
    // Only the initial read: later system scheme changes must not re-hydrate
    // over the user's choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Until hydration finishes, show the system scheme rather than the slice's
  // placeholder default so there's no light flash on a dark-mode device.
  const settings = useMemo(() => (loaded ? values : { ...values, themeMode: systemThemeMode }), [loaded, values, systemThemeMode]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => dispatch(settingsUpdated(patch)), [dispatch]);
  const resetSettings = useCallback(() => dispatch(resetSettingsThunk(systemThemeMode)), [dispatch, systemThemeMode]);

  return { settings, loaded, updateSettings, resetSettings };
}

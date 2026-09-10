import { useColorScheme } from 'react-native';

/**
 * The single source for the app's accent color - every UI element that
 * needs it (buttons, links, the current-track/current-lyric-line tint,
 * slider fill, etc.) reads it from Colors.accent rather than hardcoding a
 * hex value, so this is the only place a future "accent color" setting
 * would need to write to (e.g. swapping this constant for a value read out
 * of a settings store, or making useThemeColors take an override).
 */
export const DEFAULT_ACCENT_COLOR = '#6181b8';

export type ThemeMode = 'light' | 'flux' | 'dark' | 'amoled';

export interface Colors {
  background: string;
  text: string;
  subtleText: string;
  accent: string;
}

export const lightColors: Colors = {
  background: '#ffffff',
  text: '#111111',
  subtleText: '#111111',
  accent: DEFAULT_ACCENT_COLOR,
};

/** Warm-light variant - the same light-mode text/contrast levels as `lightColors`, on a cream background instead of stark white, for reading in low light without going all the way to a dark theme. */
export const fluxColors: Colors = {
  background: '#fbf1de',
  text: '#3a2c17',
  subtleText: '#3a2c17',
  accent: DEFAULT_ACCENT_COLOR,
};

export const darkColors: Colors = {
  background: '#111111',
  text: '#f5f5f5',
  subtleText: '#f5f5f5',
  accent: DEFAULT_ACCENT_COLOR,
};

/** True black background (not just dark gray like `darkColors`) so OLED/AMOLED panels can actually turn those pixels off. */
export const amoledColors: Colors = {
  background: '#000000',
  text: '#f5f5f5',
  subtleText: '#f5f5f5',
  accent: DEFAULT_ACCENT_COLOR,
};

/**
 * Both apps computed this identically from useColorScheme() before the
 * settings page existed - `mode`/`accentColor` are now the source of truth
 * once a user has settings loaded (see useAppSettings), and this still
 * falls back to the system color scheme when `mode` is omitted so any
 * caller that hasn't been updated to pass settings keeps its old behavior.
 */
export function useThemeColors(mode?: ThemeMode, accentColor?: string): Colors {
  const systemIsDark = useColorScheme() === 'dark';
  const resolvedMode = mode ?? (systemIsDark ? 'dark' : 'light');
  const base =
    resolvedMode === 'flux' ? fluxColors : resolvedMode === 'dark' ? darkColors : resolvedMode === 'amoled' ? amoledColors : lightColors;
  if (!accentColor || accentColor === base.accent) return base;
  return { ...base, accent: accentColor };
}

/**
 * A translucent variant of a hex color (e.g. Colors.accent) - for the
 * background tints/fills that used to be hardcoded rgba(...) literals
 * alongside a hardcoded accent hex. Takes the color as an argument rather
 * than baking fixed alpha variants into Colors itself, so call sites stay
 * correct if the accent color ever becomes runtime-configurable.
 */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * A darkened variant of a hex color (e.g. Colors.accent), for the rare spot
 * that used to hardcode a manually-picked darker shade of the old fixed
 * accent (e.g. the primary transport button standing out from the smaller
 * ones around it) - mixes toward black by `amount` (0-1) rather than a
 * second hardcoded hex, so it still tracks whatever the accent actually is.
 */
export function darken(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const r = Math.round(parseInt(clean.substring(0, 2), 16) * (1 - amount));
  const g = Math.round(parseInt(clean.substring(2, 4), 16) * (1 - amount));
  const b = Math.round(parseInt(clean.substring(4, 6), 16) * (1 - amount));
  return `rgb(${r}, ${g}, ${b})`;
}

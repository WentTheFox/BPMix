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

export const darkColors: Colors = {
  background: '#111111',
  text: '#f5f5f5',
  subtleText: '#f5f5f5',
  accent: DEFAULT_ACCENT_COLOR,
};

/** Both apps computed this identically from useColorScheme() - shared so a future palette tweak only has one place to land. */
export function useThemeColors(): Colors {
  return useColorScheme() === 'dark' ? darkColors : lightColors;
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

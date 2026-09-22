import { DEFAULT_ACCENT_COLOR } from '../theme';
import type { ThemeMode } from '../theme';

export interface AppSettings {
  themeMode: ThemeMode;
  /** An AccentColorOption.id (see ACCENT_COLOR_OPTIONS/getAccentColorHex) - NOT a hex value. Storing the id rather than the hex it currently resolves to means a future retune of the palette's saturation/lightness formula reflows every existing install's choice along with it, instead of leaving already-saved settings pointing at a shade the picker itself no longer offers. */
  accentColor: string;
  volumeNormalizationEnabled: boolean;
  crossfadeSeconds: number;
  /** Hides the Now Playing screen's lyrics panel entirely (and skips fetching lyrics for the current track) to free up vertical space for users who don't use lyrics. */
  lyricsEnabled: boolean;
  /** Hides PlayerControlsRow's volume button on the Now Playing screen - the volume slider on the Settings screen itself (see SettingsScreen's "Volume" section) is always shown regardless of this, so volume stays reachable even with it off. */
  showVolumeButtonOnNowPlaying: boolean;
  /**
   * A Last.fm API app's key/secret (see last.fm/api/account/create) -
   * bring-your-own, same "own API key" self-hosting pattern as the DeepL
   * key noted in CLAUDE.md's TODO, not a key baked into the app itself.
   * Only these two are directly user-edited; lastFmSessionKey/
   * lastFmUsername below are written by useLastFmConnection's auth flow,
   * never typed in directly.
   */
  lastFmApiKey: string;
  lastFmApiSecret: string;
  /** Null until useLastFmConnection's auth flow completes. Clearing this (disconnect) is what actually turns scrobbling off - the api key/secret alone don't scrobble anything without a session. */
  lastFmSessionKey: string | null;
  /** Display-only - the Last.fm username lastFmSessionKey authenticates as, so Settings can show "Connected as X" without a extra API round trip. */
  lastFmUsername: string | null;
  /**
   * Show the current track as a Discord Rich Presence status - unlike
   * Last.fm, there's no credential to enter (a Discord application id
   * isn't confidential - see DEFAULT_DISCORD_APPLICATION_ID's doc), just
   * this on/off toggle. Only takes effect where a DiscordPresenceBridge
   * actually exists (Android; Windows/web have none yet - see
   * useDiscordPresence's doc), so leaving it on elsewhere is harmless.
   */
  discordRichPresenceEnabled: boolean;
}

export interface AccentColorOption {
  id: string;
  hex: string;
}

/** "Glaucous" - the actual name of this pale blue-grey hue, and the app's signature color since before this setting existed. */
export const DEFAULT_ACCENT_COLOR_ID = 'glaucous';

/**
 * Preset swatches for the settings screen's accent color picker - a full
 * color picker is more control than a single-hue accent tint needs. Spread
 * evenly around the hue wheel at 15° steps (a consistent 45%/56%
 * saturation/lightness) so the row reads as a full rainbow rather than a
 * handful of arbitrarily chosen colors. DEFAULT_ACCENT_COLOR (the existing
 * default, and every install's accent before this setting existed) is kept
 * as an exact value in its place on the wheel (~218°) rather than nudged
 * onto the nearest 15° step, replacing the generated swatch that would
 * otherwise have landed one step away from it (225°) - two near-identical
 * blues one step apart would be a pointless choice to offer.
 */
export const ACCENT_COLOR_OPTIONS: AccentColorOption[] = [
  { id: 'red', hex: '#c15c5c' }, // 0°
  { id: 'vermilion', hex: '#c1765c' }, // 15°
  { id: 'orange', hex: '#c18f5c' }, // 30°
  { id: 'amber', hex: '#c1a85c' }, // 45°
  { id: 'yellow', hex: '#c1c15c' }, // 60°
  { id: 'lime', hex: '#a8c15c' }, // 75°
  { id: 'chartreuse', hex: '#8fc15c' }, // 90°
  { id: 'springGreen', hex: '#76c15c' }, // 105°
  { id: 'green', hex: '#5cc15c' }, // 120°
  { id: 'emerald', hex: '#5cc176' }, // 135°
  { id: 'teal', hex: '#5cc18f' }, // 150°
  { id: 'turquoise', hex: '#5cc1a8' }, // 165°
  { id: 'cyan', hex: '#5cc1c1' }, // 180°
  { id: 'sky', hex: '#5ca8c1' }, // 195°
  { id: 'azure', hex: '#5c8fc1' }, // 210°
  { id: DEFAULT_ACCENT_COLOR_ID, hex: DEFAULT_ACCENT_COLOR }, // ~218°
  { id: 'indigo', hex: '#5c5cc1' }, // 240°
  { id: 'violet', hex: '#765cc1' }, // 255°
  { id: 'purple', hex: '#8f5cc1' }, // 270°
  { id: 'orchid', hex: '#a85cc1' }, // 285°
  { id: 'magenta', hex: '#c15cc1' }, // 300°
  { id: 'fuchsia', hex: '#c15ca8' }, // 315°
  { id: 'rose', hex: '#c15c8f' }, // 330°
  { id: 'crimson', hex: '#c15c76' }, // 345°
];

/** Resolves an accentColor id (AppSettings.accentColor) to the hex value it currently means - falls back to the default for an id that's missing, unrecognized, or (pre-migration) still a raw hex string from before accentColor became an id, so a stale/corrupt value never breaks rendering. */
export function getAccentColorHex(id: string): string {
  return ACCENT_COLOR_OPTIONS.find((option) => option.id === id)?.hex ?? DEFAULT_ACCENT_COLOR;
}

export const MIN_CROSSFADE_SECONDS = 1;
export const MAX_CROSSFADE_SECONDS = 20;

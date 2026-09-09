import {
  mdiAlertCircle,
  mdiAlertCircleOutline,
  mdiArrowLeft,
  mdiBellOutline,
  mdiChevronDown,
  mdiChevronUp,
  mdiClose,
  mdiFolder,
  mdiFolderMusic,
  mdiFolderPlus,
  mdiMusicNote,
  mdiPause,
  mdiPlay,
  mdiPlaylistMusic,
  mdiProgressClock,
  mdiRefresh,
  mdiRepeat,
  mdiRepeatOnce,
  mdiShuffle,
  mdiSkipNext,
  mdiSkipPrevious,
  mdiSubtitles,
  mdiTrashCanOutline,
  mdiVolumeHigh,
  mdiVolumeLow,
  mdiVolumeMedium,
  mdiVolumeOff,
} from '@mdi/js';
import React from 'react';
import { Text } from 'react-native';

export interface IconProps {
  /** An MDI path string, e.g. `mdiPlay` from '@mdi/js'. */
  path: string;
  size?: number;
  color?: string;
}

/**
 * Windows has no react-native-svg build (its native module hardcodes the
 * v143 UWP toolset, which this VS install - "18"/2026 - doesn't offer at
 * all, only VS2022 does), so the shared Icon.tsx's raw-path SVG rendering
 * doesn't work here. A bundled app-packaged webfont doesn't work either:
 * RNW's Fabric text layout (WindowsTextLayoutManager.cpp) calls DirectWrite's
 * CreateTextFormat with a hardcoded null font collection, i.e. it can only
 * resolve fonts already registered with Windows itself - there's no API path
 * to an app-content font at all, regardless of the UWP XAML "path#Family"
 * convention (which only applies to XAML TextBlock, not this renderer).
 *
 * So this uses Segoe Fluent Icons instead - the system icon font that ships
 * preinstalled with Windows 11, which is why it resolves with no bundling or
 * deployment step. It keeps the same PUA codepoints as the older Segoe MDL2
 * Assets for standard glyphs like play/pause/skip. @mdi/js only exports path
 * data, not codepoints, so this maps each path constant this app actually
 * uses to its glyph by hand - add an entry here whenever a new icon is used
 * (verified per-glyph by rendering candidate codepoints with GDI+ and
 * inspecting the result, rather than trusting a codepoint list blind).
 * Falls back to a "?" glyph for anything not yet mapped, rather than
 * rendering nothing - note that unlike most fonts, Segoe Fluent Icons is a
 * PUA-only icon font with no ordinary-Unicode coverage at all (confirmed
 * via GDI+: even a plain U+25A0 BLACK SQUARE renders as the font's own
 * missing-glyph tofu box, not the intended square), so the fallback has to
 * be one of this font's own PUA glyphs too, not an arbitrary character.
 */
const CODEPOINTS: Record<string, number> = {
  [mdiPlay]: 0xe768,
  [mdiPause]: 0xe769,
  [mdiSkipNext]: 0xe893,
  [mdiSkipPrevious]: 0xe892,
  [mdiRepeat]: 0xe8ee,
  [mdiRepeatOnce]: 0xe8ed,
  [mdiShuffle]: 0xe8b1,
  [mdiMusicNote]: 0xec4f,
  [mdiFolder]: 0xe8b7,
  [mdiFolderPlus]: 0xe8f4, // "NewFolder" - a folder with a plus-circle overlay
  // Segoe Fluent Icons has no music-specific folder variant (checked the full
  // name->codepoint table, nothing combines "Folder" and "Music") - reuses
  // "NewFolder" since both buttons mean "add a folder" and there's no way to
  // visually distinguish "music" from "lyrics" via a single-glyph icon font.
  [mdiFolderMusic]: 0xe8f4,
  [mdiPlaylistMusic]: 0xe90b, // "MusicNoteList" - list lines with a music note
  [mdiRefresh]: 0xe72c,
  [mdiArrowLeft]: 0xe72b, // "Back"
  [mdiSubtitles]: 0xed1e, // "Subtitles" - a rounded box with horizontal text lines
  [mdiTrashCanOutline]: 0xe74d, // "Delete" - a trash can
  // "Volume0"-"Volume3" - sourced from Microsoft's own published Segoe
  // Fluent Icons codepoint table (see the segoe-fluent-icons-codepoints
  // memory), not independently GDI+-verified since that table is itself an
  // authoritative source rather than a guess.
  [mdiVolumeOff]: 0xe992, // "Volume0"
  [mdiVolumeLow]: 0xe993, // "Volume1"
  [mdiVolumeMedium]: 0xe994, // "Volume2"
  [mdiVolumeHigh]: 0xe995, // "Volume3"
  // Added for the notification bell + missing-track indicator (see
  // NotificationBell.tsx/TrackRow.tsx) - sourced from the same official
  // codepoint table as the volume glyphs above, no GDI+ re-verification.
  [mdiAlertCircle]: 0xeb90, // "StatusErrorFull" - filled error/alert circle, used for the red error rows
  [mdiAlertCircleOutline]: 0xe783, // "Error" - outline alert glyph, used for the faded missing-track marker
  [mdiBellOutline]: 0xea8f, // "Ringer" - the font's only bell glyph
  [mdiChevronDown]: 0xe70d, // "ChevronDown"
  [mdiChevronUp]: 0xe70e, // "ChevronUp"
  [mdiClose]: 0xe711, // "Cancel" - the font's "X" close glyph
  [mdiProgressClock]: 0xe917, // "Clock" - no dedicated "in progress" glyph exists, closest semantic match
};

const FALLBACK_CODEPOINT = 0xe11b; // "StatusErrorFull" (a "?" in a circle) - visible placeholder for an unmapped icon, not a silent blank.

export function Icon({ path, size = 24, color = '#000' }: IconProps) {
  const codepoint = CODEPOINTS[path] ?? FALLBACK_CODEPOINT;
  const glyph = String.fromCodePoint(codepoint);
  return (
    // RNW's Fabric text layout (WindowsTextLayoutManager.cpp) places the
    // baseline at 0.8*lineHeight from the top of the line box. This font's
    // glyphs have zero descent (measured via GDI+ GraphicsPath.AddString -
    // ascent alone spans the full em, and each glyph sits symmetrically
    // within that em box), so the glyph is vertically centered in the line
    // box exactly when lineHeight = fontSize / 0.6 - independent of which
    // glyph, since the derivation cancels out each one's own margin.
    <Text style={{ fontFamily: 'Segoe Fluent Icons', fontSize: size, color, lineHeight: size / 0.6 }}>{glyph}</Text>
  );
}

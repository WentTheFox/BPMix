# Conventions

  * We're using React Native mainly to avoid duplicating code between mobile and web - implement shared components (and other shareable logic) in `packages/ui`/`packages/core` rather than duplicating them per-app whenever possible. This has been missed more than once (identical `FlatList` wiring, a debug-preview component, prop-threading for the same hook) because `apps/mobile/App.tsx` and `apps/web/src/App.tsx` are still large inline-JSX files that a per-app UI change is easy to make without noticing the other file already has the same shape. **When editing UI logic in one of those two files, check the same area of the other one before considering the change done** - if a second copy of the same JSX/logic would now exist (or already exists from a past change), extract it into `packages/ui` as a real component (not just a leaf widget like `TrackRow`) rather than letting both copies sit there to drift apart later.
  * Aim for a single component per `.tsx` file.
  * Windows has no react-native-svg build (see `Icon.windows.tsx`'s header comment for why), so it renders icons as glyphs from the system "Segoe Fluent Icons" font via a hand-maintained `CODEPOINTS` map in that file, keyed by each `@mdi/js` path constant - `@mdi/js` only exports SVG path data, not the font's PUA codepoints, so this can't be auto-derived. **Whenever a new `mdi*` icon is imported and used anywhere reachable on Windows** (shared `packages/ui` code, or `apps/mobile/App.tsx`), add a matching entry to that map in the same change - don't wait for it to be reported as a missing/wrong glyph (a "?" fallback) on Windows. Never guess a codepoint: render candidates for "Segoe Fluent Icons" via GDI+ (`System.Drawing`, draw candidate `[char]::ConvertFromUtf32($cp)` values to a bitmap, read the PNG back to visually confirm) before committing to one - guessed codepoints have been wrong before, and the font has no ordinary-Unicode coverage at all (a plain `■` U+25A0 renders as its own tofu/missing-glyph box), so even a fallback glyph has to be one of the font's own PUA codepoints. Icons used only in `apps/web/src/App.tsx` (not shared, not in the mobile app) don't need an entry - they never reach the Windows renderer.

# TODOS

Notes for tasks that still have to be done/investigated are left here, grouped by area:

## Crossfade / transition engine rework

  * bpm matching has to be continuously calibrated, instead of pre-calculated from the current playback window, dropping the pre-analysis step and instead focusing on the just-in-time audio data for the "past few seconds" (exact windows up to experimentation)
  * the current and next songs will have to play in parallel for the bpm analysis until there is an opportune time to fade over with the second one being muted
  * once a transition point is found we will need to fade into the second song immediately with little to no delay
  * we have to forego audio speed manipulation as a first round due to the added complexity and focus solely on getting a smooth volume transition from one song to the next
  * when fading the track's normalized gain should be taken into account as currently the current track's volume jumps drastically when a transition starts
  * current song stays on screen even after it's past the transition time
  * we need more informative debug visualization, render out the actual audio waveform along with indicators for when a beat is detected for the "past few seconds" and display it in a running timeline

## Playback state & playlist persistence

  * we have to preserve settings like last opened playlist, last played song, shuffle & looping state across application loads
  * as soon as a track starts playing we need to create an in-memory "now playing" playlist that also carries with it the shuffled track order
  * if the playlist file changed since we last started playback the new entries will need to be shuffled in or if shuffling is off, they must be added to their appropriate positions in the playlist (now playing has to track the source playlist it was derived from) and removed entries must be removed
  * report playback status to system native media APIs

## Track metadata

  * audio files should be displayed with their ID3 metadata intact, cover art on the left, title on one line, artist(s) (multiple are stored with a delimiter), and album name under it, standard stuff, along with song length
  * we can scan audio metadata asynchronously and update it as playback progresses, showing only the filename until this is done
  * tie metadata to file hash in case the song file changes on disk without a file name change
  * display live waveform of the current and next song

## UI/UX improvements

* move the "now playing" controls to a fixed bar at the bottom of the screen with play-pause-next-previous controls on the right and move everything else to a now playing screen accessible by clicking the album art+song+name+artist displayed on the left of the bar similar to the layout in the playlist

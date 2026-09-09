# Conventions

  * We're using React Native mainly to avoid duplicating code between mobile and web - implement shared components (and other shareable logic) in `packages/ui`/`packages/core` rather than duplicating them per-app whenever possible. This has been missed more than once (identical `FlatList` wiring, a debug-preview component, prop-threading for the same hook) because `apps/mobile/App.tsx` and `apps/web/src/App.tsx` are still large inline-JSX files that a per-app UI change is easy to make without noticing the other file already has the same shape. **When editing UI logic in one of those two files, check the same area of the other one before considering the change done** - if a second copy of the same JSX/logic would now exist (or already exists from a past change), extract it into `packages/ui` as a real component (not just a leaf widget like `TrackRow`) rather than letting both copies sit there to drift apart later.
  * Aim for a single component per `.tsx` file.
  * When capturing on-device screenshots on the test Android phone while debugging (`adb exec-out screencap` or similar), save them to `/sdcard/Pictures/Screenshots/BPMix/` (create it if it doesn't exist yet), not the storage root or the bare `Pictures/Screenshots/` folder - the root had accumulated ~200 loose debug PNGs from past sessions before this was cleaned up, and a project-specific subfolder keeps them out of the user's own camera/screenshot gallery view.
  * `apps/web`'s Vite config resolves `.web.ts`/`.web.tsx` platform-split files first (see `vite.config.ts`'s `resolve.extensions`), same idea as Metro's `.android.ts`/`.native.ts` resolution for mobile - but `apps/web/tsconfig.json` has no `moduleSuffixes` teaching `tsc` that same resolution (unlike `apps/mobile/tsconfig.json`, which does have it for its own suffixes). Adding `"moduleSuffixes": [".web", ""]` there was tried and reverted - it broke `tsc`'s global JSX namespace resolution (`Cannot find namespace 'JSX'`) for unrelated reasons. Net effect: a `.web.ts` file's types are currently only checked standalone (as a root file within `packages/ui`'s own `tsc` run) and by the real `vite build`/dev server - **`apps/web`'s own `tsc --noEmit` silently type-checks against the non-`.web` fallback file instead of the one Vite actually bundles**, so a type error that only exists in the `.web.ts` variant won't be caught by `pnpm typecheck`, only by actually building/running the web app. Keep that in mind (extra manual `vite build` verification) whenever adding or editing a `.web.ts`/`.web.tsx` file - see `packages/ui/src/spin/useSpin.web.ts` for the first example of this pattern.
  * The startup restore path (`packages/ui/src/usePlaybackPersistence.ts` / its planned `useLibraryStartup` successor, feeding `RestoringScreen`) is startup-latency-sensitive: it must only block on scanning the last-played root/playlist and resolving the current track's lyrics assignment. Scanning any other granted root, auto-matching lyrics for the rest of the library, and ID3 metadata scanning must stay idle-chunked/background work (see `packages/core/src/metadata/scanLibraryMetadata.ts` + `idleCallback.ts` for the pattern) that live-merges into `rootsWithLibrary`/lyrics state once done, rather than being awaited before `RestoringScreen` is dismissed. When touching this path, don't reintroduce a full-library or full-lyrics-folder scan onto the blocking critical path.
  * Windows has no react-native-svg build (see `Icon.windows.tsx`'s header comment for why), so it renders icons as glyphs from the system "Segoe Fluent Icons" font via a hand-maintained `CODEPOINTS` map in that file, keyed by each `@mdi/js` path constant - `@mdi/js` only exports SVG path data, not the font's PUA codepoints, so this can't be auto-derived. **Whenever a new `mdi*` icon is imported and used anywhere reachable on Windows** (shared `packages/ui` code, or `apps/mobile/App.tsx`), add a matching entry to that map in the same change - don't wait for it to be reported as a missing/wrong glyph (a "?" fallback) on Windows. Never guess a codepoint: render candidates for "Segoe Fluent Icons" via GDI+ (`System.Drawing`, draw candidate `[char]::ConvertFromUtf32($cp)` values to a bitmap, read the PNG back to visually confirm) before committing to one - guessed codepoints have been wrong before, and the font has no ordinary-Unicode coverage at all (a plain `■` U+25A0 renders as its own tofu/missing-glyph box), so even a fallback glyph has to be one of the font's own PUA codepoints. Icons used only in `apps/web/src/App.tsx` (not shared, not in the mobile app) don't need an entry - they never reach the Windows renderer.
  * If an on-device Android screenshot comes back as a plain dark/blank screen with only the system status/nav bars visible (no crash in `adb logcat`, activity still shows as resumed), don't assume it's a real rendering bug - check the Metro dev server first (`lsof -i :8081` / `curl localhost:8081/status`, or just restart it with `pnpm start --reset-cache` from `apps/mobile`). A stuck/dead Metro connection leaves the app on a blank native-background screen with no visible error, and `ps aux | grep -i metro` is not a reliable way to check - the process runs as `node .../react-native/cli.js start`, not anything literally named "metro". If the test phone's USB connection drops and gets reconnected mid-session, `adb devices` coming back healthy is not enough to prove the JS bridge works again - the `adb reverse tcp:8081 tcp:8081` port forward (how the on-device app reaches the host's Metro over the USB link) is torn down by the disconnect and does NOT come back on its own when the USB cable/session reconnects. Check `adb reverse --list` (empty means it's gone) and re-run `adb reverse tcp:8081 tcp:8081` before assuming a blank-screen relaunch will actually pick up a running Metro.

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
  * the background metadata scan (both apps' `refresh()` in App.tsx) is deferred via `InteractionManager.runAfterInteractions` - that API is deprecated on the RN version we're on ("Please refactor long tasks into smaller ones, and use 'requestIdleCallback' instead"), so migrate it to `requestIdleCallback` before RN actually removes `InteractionManager`. Not a drop-in swap: `runAfterInteractions` just waits for the interaction queue to drain and runs the callback once, while `requestIdleCallback` fires (possibly repeatedly) whenever there's idle time in a frame and hands you a deadline to chunk work against - `scanLibraryMetadata` already yields cooperatively between tracks (`yieldToEventLoop`), so it's a reasonable fit for real idle-chunked scheduling, not just a like-for-like call swap.

## UI/UX improvements

* settings page with customizable accent color, ability to turn off volume normalization, and ability to change crossfade duration, wih a reset settings button that sets everything to default
* when pressing shuffle the current song is placed at the top of the playlist and other songs should appear below it in the shuffled order, this order must persist across reloads, until shuffle is toggled off (restore original playlist order preserving current track position) or if looping, when the last song ends the playlist should be reshuffled under the last song before switching to the next track
* The notification icon should only show a red badge if there are any errors or usr-actionable items, background scanning and similar non-threatening actions should result in a grey/muted badge
* on larger viewports (tablet/dsktop/web) the playlist and now playing views should appear side-by-side, with the now playing bar and its controls becoming center-aligned so they are not spread out across the entire width of the screen (opening resume persists both the current song and the opened playlist, as the now playing song may not be from the same playlist) - on the largest screen sizes even the library view with all folders can be shown 


## new features

* Support for embedded track id3 lyrics/syncedlyrics
* add an lrc syncing UI for songs with nt synced plaintext lyrics, or a resyn option that reconstructs the plain lyrics from the lrc file (tap to advance sync, swipe up to go bac to previous entry/start on first entry, swipe left to remove a line, swipe right to insert a break) with onscreen controls and instructions, as well as step 5-10seconds buttons forwards/backwards
  * this same editor should also cover the multi-language case: a track's native-language .lrc is sometimes itself unsynced (plain text) while its `<track>.<lang>.lrc` translation sibling (see `matchTranslationLines`/`loadAssignedLyrics` in `packages/core/src/lyrics/`) is fully synced - real example found on-device, "Ester Dean - Rio Music From The Motion Picture/Take You To Rio.lrc" (native, `[lang:pt]`, plain text) vs its `.en.lrc` (synced). Today BPMix just shows the unsynced native text and silently drops the synced translation in this case (a deliberate, simple choice for now). The editor should let the user manually sync the native lyrics later using the translation's existing timestamps as a starting reference/guide (or otherwise carry the translation's timing over) instead of that being a dead end
* let the user create a playlist directly from a folder (e.g. via FolderBrowser) instead of requiring an existing .m3u8 - probably a new action alongside "Select This Folder" that generates a playlist from the audio files found in that folder (recursively) and set a sorting criteria before creating (date of file creation, song title, artist name, album) and order (asc, desc) with a preview of what the top of the playlist will looks like
* advanced: sound recognition-based automatic pre-syncing with manual review (requires large R&D effort, needs eternal library maybe)

## housekeeping

* address this warning log during build
    > Deprecated Gradle features were used in this build, making it incompatible with Gradle 10.
    > 
    > You can use '--warning-mode all' to show the individual deprecation warnings and determine if they come from your own scripts or
     plugins.
    > 
    > For more on this, please refer to https://docs.gradle.org/9.4.1/userguide/command_line_interface.html#sec:command_line_warnings in the Gradle documentation.
* break each platform's App.tsx into smaller components and reusable hooks
* check for duplications in the extracted components/hooks and try to unify them as much as possible with the use of the shared "ui" package

# Verification

Before considering a code change done, run from the repo root:

  * `pnpm lint` runs ESLint across the whole monorepo (flat config at `eslint.config.mjs`; see its own comments for why it deviates from a couple of plugins' stock "recommended" presets).
  * `pnpm typecheck` runs each package's own `tsc --noEmit`, not one repo-wide invocation (see each package's `tsconfig.json` for why).
  * `pnpm test` runs every package's test suite (`packages/core`'s Vitest suite, `apps/mobile`'s Jest smoke test).
  * Run a real `pnpm --filter @bpmix/web build` (or `pnpm web` and click through it) whenever a change touches a `.web.ts`/`.web.tsx` file. `apps/web`'s `tsc --noEmit` silently type-checks against the non-`.web` fallback file instead of the one Vite actually bundles (see `packages/ui/src/spin/useSpin.web.ts` for the first example of this split), so a `.web.ts`-only type error won't be caught by `pnpm typecheck` alone.
  * For a UI/frontend change, also run the app (`pnpm web`, or the mobile/Windows app) and use the feature. The commands above verify correctness, not that the feature works as intended.

# Conventions

  * React Native exists here mainly to avoid duplicating code between mobile and web, so implement shared components/logic in `packages/ui`/`packages/core` rather than duplicating them per-app. `apps/mobile/App.tsx` and `apps/web/src/App.tsx` are still large inline-JSX files, so a per-app change is easy to make without noticing the other file has the same shape. **When editing UI logic in one of those two files, check the same area of the other before considering the change done.** If a second copy of the same JSX/logic would now exist, extract it into `packages/ui` instead of letting both drift.
  * Aim for a single component per `.tsx` file.
  * On-device Android debug screenshots go in `/sdcard/Pictures/Screenshots/BPMix/` (create if missing), not the storage root or bare `Pictures/Screenshots/`. This keeps debug PNGs out of the user's own camera/screenshot gallery.
  * The startup restore path (`packages/ui/src/usePlaybackPersistence.ts`, feeding `RestoringScreen`) is startup-latency-sensitive. It must only block on scanning the last-played root/playlist and resolving the current track's lyrics assignment. Any other root scan, library-wide lyrics matching, and ID3 metadata scanning must stay idle-chunked background work (see `scanLibraryMetadata.ts` + `idleCallback.ts`) that live-merges in afterward, not something `RestoringScreen` waits on.
  * Windows has no react-native-svg build, so icons render as glyphs from "Segoe Fluent Icons" via a hand-maintained `CODEPOINTS` map in `Icon.windows.tsx`, keyed by each `@mdi/js` path constant. **Whenever a new `mdi*` icon is used anywhere reachable on Windows** (shared `packages/ui` code or `apps/mobile/App.tsx`), add a matching entry in the same change. Never guess a codepoint. Render candidates via GDI+ and visually confirm before committing (guessed ones have been wrong before; the font has no ordinary-Unicode fallback). Icons used only in `apps/web/src/App.tsx` don't need an entry.
  * If an on-device Android screenshot comes back plain dark/blank (no crash in `adb logcat`, activity still resumed), check Metro first (`curl localhost:8081/status`, or restart with `pnpm start --reset-cache`) before assuming a rendering bug. If the phone's USB connection dropped and reconnected mid-session, `adb reverse tcp:8081 tcp:8081` needs re-running (`adb reverse --list` to check). It doesn't survive a USB reconnect on its own.
  * If the user reports a new, unrelated bug while a feature implementation is already in progress, don't stop to investigate inline. Spawn a background subagent to investigate in parallel, keep going, and fold its findings in once it reports back.
  * The test phone's normally-installed app is a real, CI-signed release build. It isn't debuggable and doesn't connect to Metro. For live-source testing, `apps/mobile/android/app/build.gradle`'s `debug` build type has `applicationIdSuffix ".debug"`, so `pnpm android` installs a Metro-connected build side by side as `tf.went.bpmix.debug` (a plain debug build's signature never matches the CI-signed release, so it can't install over it). Grant storage access with `adb shell appops set tf.went.bpmix.debug MANAGE_EXTERNAL_STORAGE allow` and launch with `adb shell monkey -p tf.went.bpmix.debug -c android.intent.category.LAUNCHER 1` (`react-native run-android`'s own launch step targets the un-suffixed package and will just refocus the release app).

# TODOS

Notes for tasks that still have to be done/investigated are left here, grouped by area. **When an item below is actually completed, remove it from this list in the same change** - don't leave finished work sitting here as if it were still outstanding.

## Crossfade / transition engine rework

  * bpm matching has to be continuously calibrated, instead of pre-calculated from the current playback window, dropping the pre-analysis step and instead focusing on the just-in-time audio data for the "past few seconds" (exact windows up to experimentation)
  * the current and next songs will have to play in parallel for the bpm analysis until there is an opportune time to fade over with the second one being muted
  * once a transition point is found we will need to fade into the second song immediately with little to no delay
  * we have to forego audio speed manipulation as a first round due to the added complexity and focus solely on getting a smooth volume transition from one song to the next
  * current song stays on screen even after it's past the transition time
  * we need more informative debug visualization, render out the actual audio waveform along with indicators for when a beat is detected for the "past few seconds" and display it in a running timeline

## Playback state & playlist persistence

* report playback status to system native media APIs and allow external control. Done and verified live for Android and web. Still needed: Windows SMTC (`apps/mobile/src/adapters/mediaSessionNotification.windows.ts` is currently a no-op placeholder), likely its own native module.
* Last.fm scrobbling
* Discord rich presence

## Track metadata

* display live waveform of the current song

## UI/UX improvements

* Store 5-15s of audio data alongside file metadata records using the most space efficient encoding method to make audio playback on song press more responsive, swap out to the real track seamlessly once it's loaded
* Settings toggle to display a single disk visualization at a time only, handle track switching and prelading gracefully still

## new features

* Support for embedded track id3 lyrics/syncedlyrics
* Playlist editor - ability to move playlist items by multi-selection and long-pressing/right-clicking (context menu) on an existing song to be able to move songs before-after. (Adding a song to the start or end of a playlist is done - see `addTracksToPlaylist` in `packages/core/src/library-scan/`, exposed today via the Unplaylisted automatic view's per-row "add to playlist" action; reordering/moving *existing* entries is the remaining piece.)
* add an lrc syncing UI for songs with nt synced plaintext lyrics, or a resync option that reconstructs the plain lyrics from the lrc file (tap to advance sync, swipe up to go bac to previous entry/start on first entry, swipe left to remove a line, swipe right to insert a break) with onscreen controls and instructions, as well as step 5-10seconds buttons forwards/backwards
  * this same editor should also cover the multi-language case: a track's native-language .lrc is sometimes itself unsynced (plain text) while its `<track>.<lang>.lrc` translation sibling (see `matchTranslationLines`/`loadAssignedLyrics` in `packages/core/src/lyrics/`) is fully synced - real example found on-device, "Ester Dean - Rio Music From The Motion Picture/Take You To Rio.lrc" (native, `[lang:pt]`, plain text) vs its `.en.lrc` (synced). Today BPMix just shows the unsynced native text and silently drops the synced translation in this case (a deliberate, simple choice for now). The editor should let the user manually sync the native lyrics later using the translation's existing timestamps as a starting reference/guide (or otherwise carry the translation's timing over) instead of that being a dead end
  * add a separate time adjust mode, sometimes lyrics just star at different times but other timings might already be consistent, for simple cases like this we can just shift all time entries by a customizable amount instead of having to resync the whole song
* advanced: sound recognition-based automatic pre-syncing with manual review (requires large R&D effort, needs eternal library maybe)
* automatic translated lyrics generation using DeepL API key (translate whole lyrics in timed order, correctly flattening lrc lines with multiple timestamps per line) and writing to file - needs its own masked/secret API key field added to the settings screen (`packages/ui/src/settings/SettingsScreen.tsx`) or env var for self-hosted instance (disables editing the setting)

## housekeeping

* 3-tier responsive layout (`useViewportTier`, `MultiPaneLayout`): medium tier is verified live on Android and Windows. Wide tier is unverified everywhere. On Windows it's actually unreachable at any window size, because `useWindowDimensions()` never updates on a live resize there (root cause: `node_modules/react-native-windows/Microsoft.ReactNative/Modules/DeviceInfoModule.cpp`'s `InitDeviceInfoHolder` only wires up `WM_WINDOWPOSCHANGED` `if (IsFabricEnabled(...))`, and this build has Fabric on, so the gap is further in; this is an upstream RNW bug, not our code, worth checking for an existing issue/newer RNW version before patching around it locally). On Android, wide needs a true tablet/foldable to test (a regular phone only reaches medium, in landscape).
* Windows (`apps/mobile/windows/Mobile/FileAccessModule.h`) needs a real, process-wide async-safe limit on concurrent WinRT storage reads. Two overlapping `GetBasicPropertiesAsync`/`ReadBufferAsync`/`ReadTextAsync` calls against the same granted root (even for different files) throw a bare "The file is in use" WinRT error, not a real file lock. Per-call/per-`ListDirectory` batching already fixed the worst case, but a full library metadata scan running concurrently with active playback still reliably stalls out on this. It needs a global async semaphore/serialized queue gating every WinRT storage read against every other one; not attempted since a hand-rolled async-safe primitive in C++/WinRT coroutines needs real scrutiny (a plain `std::mutex` can't be held across a `co_await`). This blocks fully verifying this repo's playback-heavy changes (shuffle persistence, restore-vs-manual race fix, per-track loading spinner, reconcilePlaylist-on-rescan) on Windows; UI/interaction-level checks there are fine already.
* CrossfadeArt's Windows tonearm sweep is still broken. See the live doc comment on `Tonearm` in `packages/ui/src/CrossfadeArt.tsx` for what's been tried (transformOrigin, a 1x1 pivot box, neither worked) and what to try next (a visible debug background on the rotor box, checked live on Windows). A past commit message claims this was fixed. It wasn't; re-verified live and it still reproduces.
* remove `patches/react-native-audio-api@0.13.3.patch` and its `pnpm-workspace.yaml` entry once upstream PR https://github.com/software-mansion/react-native-audio-api/pull/1281 (fixes the native seek memory leak, issue #1263) lands in a released version and the dependency is bumped past it
* implement `FileAccess.writeFileText` on Windows (`apps/mobile/src/adapters/fileAccess.windows.ts`) so "create a playlist from a folder" works there too. It currently throws "not supported yet". Needs `patches/react-native-scoped-storage.patch` to stop masking out `FLAG_GRANT_WRITE_URI_PERMISSION`, plus a way to prompt an already-granted root for a write-permission upgrade (existing grants are read-only)
* F-Droid publishing is blocked on Hermes. Their scanner deletes any `hermesc` binary with no substitute, and this project's Hermes ("V1", no matching upstream tag) has no known open-source build path to replace it. The `jsc-android` fallback exists in `build.gradle` but is unverified against F-Droid's scanner (likely just trades one prebuilt-binary problem for another). Shelved, not attempted further.

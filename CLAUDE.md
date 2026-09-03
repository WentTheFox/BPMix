# Conventions

  * We're using React Native mainly to avoid duplicating code between mobile and web - implement shared components (and other shareable logic) in `packages/ui`/`packages/core` rather than duplicating them per-app whenever possible.
  * Aim for a single component per `.tsx` file.

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

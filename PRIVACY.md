# Beatseam Privacy Policy

_Effective 1 November 2026_

Beatseam is a music player for your own audio files. It has no ads, no analytics
and no crash reporting, and the developer (WentTheFox) does not operate any
server that Beatseam sends your data to. This policy explains what stays on
your device and what leaves it when you choose to use an optional feature.

## What stays on your device

Beatseam reads audio files and playlists from the folders you grant it access
to. It stores the following **locally on your device** so the app works:

- a library index (file paths, track titles, artists, durations, detected BPM,
  cover art thumbnails, lyrics assignments)
- your playlists, settings and last playback position
- optional credentials for features you turn on (see below)

This data is never sent to the developer. Uninstalling the app removes it.
Your audio files and `.lrc` / playlist files stay where they are; Beatseam only
writes to them when you explicitly edit lyrics or a playlist.

## Optional features that send data

### Last.fm scrobbling

If you connect a Last.fm account, Beatseam sends the track, artist, album and
play time of what you listen to to Last.fm (`ws.audioscrobbler.com`), and the
session key Last.fm issues is stored on your device. Last.fm's handling of that
data is covered by [Last.fm's privacy policy](https://www.last.fm/legal/privacy).
You can disconnect at any time in Settings.

### Discord rich presence

If you enable it, the current track, artist and (where available) cover art
link are passed to the Discord app running on your own device, which shows them
as your activity. Beatseam does not contact Discord's servers itself.

### Self-hosted Beatseam server

Beatseam can connect to a Beatseam server that you or someone you trust runs.
When connected, the app sends that server the information needed to sync your
library and playback between devices: library and track metadata, playlists,
playback state, preferences, lyrics changes and lyrics problem reports, and your
sign-in details (username, password, authenticator code or passkey). **That
server is operated by whoever hosts it, not by the developer of Beatseam**, and
that operator's own policies govern what it keeps. If you do not enter a server
address, nothing is sent anywhere.

### Update check (Android sideload builds)

The Android sideload build checks the GitHub Releases API
(`api.github.com`) for a newer version when you ask it to. GitHub receives your
IP address with that request, as with any web request. The Microsoft Store
version of Beatseam does not do this; the Store handles updates.

## Information we do not collect

The developer does not collect, receive, sell or share any personal
information, usage statistics, device identifiers or location data.

## Permissions

- **File and folder access**: to read the music folders you choose.
- **Internet access**: only for the optional features above.
- **Full trust (Windows desktop app)**: Beatseam is a standard desktop
  application packaged for the Microsoft Store; this does not give it any extra
  access beyond what is described here.

## Children

Beatseam is not directed at children and does not knowingly collect personal
information from anyone.

## Changes

If this policy changes, the updated version will be published at this address
with a new effective date.

## Contact

Questions or requests: open an issue at
<https://github.com/WentTheFox/Beatseam/issues>.

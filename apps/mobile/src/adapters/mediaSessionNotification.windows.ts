export interface MediaSessionNotificationInfo {
  title: string;
  artist: string | null;
  album: string | null;
  artworkUri: string | null;
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;
}

export interface MediaSessionNotificationCallbacks {
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeekTo: (positionSeconds: number) => void;
}

/**
 * No-op on Windows - the Android implementation (see mediaSessionNotification.android.ts)
 * depends on react-native-audio-api's PlaybackNotificationManager, which
 * Windows doesn't use for playback at all (see audioEngine.windows.ts's own
 * native-module-backed engine instead). SMTC (System Media Transport
 * Controls) integration for Windows is its own separate TODO.
 */
export function useMediaSessionNotification(_info: MediaSessionNotificationInfo | null, _callbacks: MediaSessionNotificationCallbacks): void {}

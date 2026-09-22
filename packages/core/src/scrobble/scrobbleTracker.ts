import { meetsScrobbleThreshold } from './lastfm';

export interface ScrobbleTrackInfo {
  fileId: string;
  artist: string;
  title: string;
  album: string | null;
  durationSeconds: number;
}

export interface ScrobbleTrackerCallbacks {
  /** Fired once per play instance, the first poll tick where it's actually audible. */
  onNowPlaying: (info: ScrobbleTrackInfo) => void;
  /** Fired once per play instance, the first poll tick that crosses the Last.fm scrobble threshold. */
  onScrobble: (info: ScrobbleTrackInfo, startedAtUnixSeconds: number) => void;
}

/** A position drop bigger than this (loop-one restarting, or the user replaying the same track from the start) is treated as a new play instance rather than normal forward playback/a small seek-back. */
const RESTART_DETECTION_SECONDS = 5;

/**
 * Drives Last.fm's two calls (now-playing, then scrobble) off nothing but
 * repeated `update()` polls carrying the current playback snapshot - the
 * same ~200ms poll every caller already runs for the seek bar/persistence,
 * not a separate timer. Same fileId is usually "still the same play", but
 * loop-one/replaying-the-same-track-from-the-start both keep fileId
 * unchanged while position visibly rewinds, so a backward jump past
 * RESTART_DETECTION_SECONDS is treated as a fresh play instance too -
 * otherwise a looped track would only ever scrobble once, no matter how
 * many times it repeats.
 */
export class ScrobbleTracker {
  private currentFileId: string | null = null;
  private lastPositionSeconds = 0;
  private startedAtUnixSeconds = 0;
  private nowPlayingSent = false;
  private scrobbled = false;

  constructor(
    private readonly callbacks: ScrobbleTrackerCallbacks,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  update(info: ScrobbleTrackInfo | null, isPlaying: boolean, positionSeconds: number): void {
    if (!info) {
      this.currentFileId = null;
      return;
    }

    const isNewInstance = info.fileId !== this.currentFileId || positionSeconds < this.lastPositionSeconds - RESTART_DETECTION_SECONDS;
    if (isNewInstance) {
      this.currentFileId = info.fileId;
      this.nowPlayingSent = false;
      this.scrobbled = false;
      this.startedAtUnixSeconds = Math.floor(this.nowFn() / 1000);
    }
    this.lastPositionSeconds = positionSeconds;

    if (isPlaying && !this.nowPlayingSent) {
      this.nowPlayingSent = true;
      this.callbacks.onNowPlaying(info);
    }
    if (!this.scrobbled && meetsScrobbleThreshold(info.durationSeconds, positionSeconds)) {
      this.scrobbled = true;
      this.callbacks.onScrobble(info, this.startedAtUnixSeconds);
    }
  }
}

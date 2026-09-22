import { describe, expect, it, vi } from 'vitest';
import { ScrobbleTracker } from './scrobbleTracker';
import type { ScrobbleTrackInfo } from './scrobbleTracker';

const TRACK_A: ScrobbleTrackInfo = { fileId: 'a', artist: 'Artist A', title: 'Track A', album: null, durationSeconds: 200 };
const TRACK_B: ScrobbleTrackInfo = { fileId: 'b', artist: 'Artist B', title: 'Track B', album: null, durationSeconds: 20 };
const TRACK_C: ScrobbleTrackInfo = { fileId: 'c', artist: 'Artist C', title: 'Track C', album: null, durationSeconds: 60 };

function makeTracker(nowSeconds = 1_000) {
  const onNowPlaying = vi.fn();
  const onScrobble = vi.fn();
  const tracker = new ScrobbleTracker({ onNowPlaying, onScrobble }, () => nowSeconds * 1000);
  return { tracker, onNowPlaying, onScrobble };
}

describe('ScrobbleTracker', () => {
  it('fires onNowPlaying once at the start of playback, not on every poll', () => {
    const { tracker, onNowPlaying } = makeTracker();
    tracker.update(TRACK_A, true, 0);
    tracker.update(TRACK_A, true, 1);
    tracker.update(TRACK_A, true, 2);
    expect(onNowPlaying).toHaveBeenCalledTimes(1);
    expect(onNowPlaying).toHaveBeenCalledWith(TRACK_A);
  });

  it('does not fire onNowPlaying while paused, but does once playback starts', () => {
    const { tracker, onNowPlaying } = makeTracker();
    tracker.update(TRACK_A, false, 0);
    expect(onNowPlaying).not.toHaveBeenCalled();
    tracker.update(TRACK_A, true, 0);
    expect(onNowPlaying).toHaveBeenCalledTimes(1);
  });

  it('scrobbles once the threshold (50% or 4min, whichever is smaller) is crossed, exactly once', () => {
    const { tracker, onScrobble } = makeTracker(5_000);
    tracker.update(TRACK_A, true, 0);
    tracker.update(TRACK_A, true, 90);
    expect(onScrobble).not.toHaveBeenCalled();
    tracker.update(TRACK_A, true, 100); // 50% of 200s
    expect(onScrobble).toHaveBeenCalledTimes(1);
    expect(onScrobble).toHaveBeenCalledWith(TRACK_A, 5_000);
    tracker.update(TRACK_A, true, 150);
    expect(onScrobble).toHaveBeenCalledTimes(1);
  });

  it('never scrobbles a track under the 30s minimum', () => {
    const { tracker, onScrobble } = makeTracker();
    tracker.update(TRACK_B, true, 19); // 19s of a 20s track: past 50% but under the 30s floor
    expect(onScrobble).not.toHaveBeenCalled();
  });

  it('resets and re-fires both callbacks when the track changes', () => {
    const { tracker, onNowPlaying, onScrobble } = makeTracker();
    tracker.update(TRACK_A, true, 100);
    expect(onNowPlaying).toHaveBeenCalledTimes(1);
    expect(onScrobble).toHaveBeenCalledTimes(1);
    tracker.update(TRACK_A, true, 190);
    tracker.update(TRACK_C, true, 0);
    expect(onNowPlaying).toHaveBeenCalledTimes(2);
    tracker.update(TRACK_C, true, 30); // 50% of 60s
    expect(onScrobble).toHaveBeenCalledTimes(2);
  });

  it('treats a large backward position jump on the same track as a new play instance (loop-one)', () => {
    const { tracker, onNowPlaying, onScrobble } = makeTracker();
    tracker.update(TRACK_A, true, 190);
    expect(onScrobble).toHaveBeenCalledTimes(1);
    tracker.update(TRACK_A, true, 0); // looped back to the start
    expect(onNowPlaying).toHaveBeenCalledTimes(2);
    tracker.update(TRACK_A, true, 100);
    expect(onScrobble).toHaveBeenCalledTimes(2);
  });

  it('does not treat a small seek-back as a new instance', () => {
    const { tracker, onNowPlaying } = makeTracker();
    tracker.update(TRACK_A, true, 50);
    tracker.update(TRACK_A, true, 47); // small rewind, well under the restart threshold
    expect(onNowPlaying).toHaveBeenCalledTimes(1);
  });

  it('clears current track state when playback stops entirely', () => {
    const { tracker, onNowPlaying } = makeTracker();
    tracker.update(TRACK_A, true, 0);
    tracker.update(null, false, 0);
    tracker.update(TRACK_A, true, 0); // same track played again after nothing was loaded
    expect(onNowPlaying).toHaveBeenCalledTimes(2);
  });
});

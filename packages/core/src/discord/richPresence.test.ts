import { describe, expect, it } from 'vitest';
import { buildSetActivityFrame } from './richPresence';

describe('buildSetActivityFrame', () => {
  it('omits assets entirely when there is no album art, relying on the app icon fallback', () => {
    const frame = JSON.parse(
      buildSetActivityFrame({ title: 'Track Title', artist: 'Some Artist', startedAtUnixMs: 1700000000000, albumArtUrl: null }),
    );
    expect(frame.cmd).toBe('SET_ACTIVITY');
    expect(typeof frame.nonce).toBe('string');
    expect(frame.args.activity).toEqual({
      type: 2,
      name: 'BPMix',
      details: 'Track Title',
      state: 'Some Artist',
      timestamps: { start: 1700000000000 },
    });
    expect(frame.args.activity.assets).toBeUndefined();
  });

  it('includes album art as large_image when a real http(s) URL is given', () => {
    const frame = JSON.parse(
      buildSetActivityFrame({
        title: 'Track Title',
        artist: 'Some Artist',
        startedAtUnixMs: 1700000000000,
        albumArtUrl: 'https://bpmix.went.tf/art/abc.jpg',
      }),
    );
    expect(frame.args.activity.assets).toEqual({
      large_image: 'https://bpmix.went.tf/art/abc.jpg',
      large_text: 'Track Title',
    });
  });

  it('omits assets when albumArtUrl is a data: URI - confirmed live that Discord silently rejects those', () => {
    const frame = JSON.parse(
      buildSetActivityFrame({ title: 'Track Title', artist: 'Some Artist', startedAtUnixMs: 1700000000000, albumArtUrl: 'data:image/jpeg;base64,abc' }),
    );
    expect(frame.args.activity.assets).toBeUndefined();
  });

  it('clears the activity when given null', () => {
    const frame = JSON.parse(buildSetActivityFrame(null));
    expect(frame.cmd).toBe('SET_ACTIVITY');
    expect(frame.args.activity).toBeNull();
  });

  it('gives each frame a unique nonce', () => {
    const a = JSON.parse(buildSetActivityFrame(null));
    const b = JSON.parse(buildSetActivityFrame(null));
    expect(a.nonce).not.toBe(b.nonce);
  });
});

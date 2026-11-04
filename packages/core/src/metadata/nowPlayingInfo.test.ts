import { describe, expect, it } from 'vitest';
import { METADATA_PARSER_VERSION } from './ensureMetadata';
import { resolveNowPlayingInfo } from './nowPlayingInfo';

const track = { fileId: 'a', relativePath: 'dir/song.mp3' } as never;

describe('resolveNowPlayingInfo', () => {
  it('is null without a track', () => {
    expect(resolveNowPlayingInfo(undefined, null)).toBeNull();
  });
  it('falls back to the filename and is not ready before tags are read', () => {
    expect(resolveNowPlayingInfo(track, null)).toEqual({ title: 'song.mp3', artist: null, album: null, metadataReady: false });
  });
  it('uses tags once current', () => {
    const metadata = { title: 'Song', artists: ['A', 'B'], album: 'Alb', parserVersion: METADATA_PARSER_VERSION } as never;
    expect(resolveNowPlayingInfo(track, metadata)).toEqual({ title: 'Song', artist: 'A, B', album: 'Alb', metadataReady: true });
  });
});

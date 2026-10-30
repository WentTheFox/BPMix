import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../src/db/prisma.js';
import { createPrismaLibraryStore } from '../src/db/prismaLibraryStore.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const db = createPrismaClient(TEST_DATABASE_URL);
const store = createPrismaLibraryStore(db);

beforeEach(async () => {
  await db.$transaction([
    db.track.deleteMany(),
    db.playlist.deleteMany(),
    db.trackMetadata.deleteMany(),
    db.trackAnalysis.deleteMany(),
    db.coverArt.deleteMany(),
    db.lyricsScope.deleteMany(),
    db.lyricsAssignment.deleteMany(),
    db.keyValue.deleteMany(),
  ]);
});

afterAll(() => db.$disconnect());

describe('PrismaLibraryStore', () => {
  it('round-trips tracks and updates in place', async () => {
    const track = { fileId: 'a:x.mp3', rootId: 'a', relativePath: 'x.mp3', sizeBytes: 5_000_000_000, lastModifiedMs: 1700000000123.5 };
    await store.upsertTrack(track);
    await store.upsertTrack({ ...track, sizeBytes: 7, missing: true });
    expect(await store.listTracks('a')).toEqual([{ ...track, sizeBytes: 7, missing: true }]);
    expect(await store.listTracks('b')).toEqual([]);
    await store.deleteTrack('a:x.mp3');
    expect(await store.listAllTracks()).toEqual([]);
  });

  it('keeps playlist order and duplicate entries', async () => {
    const playlist = { id: 'p', rootId: 'a', fileId: 'a:p.m3u8', name: 'p', trackFileIds: ['t2', 't1', 't2'] };
    await store.upsertPlaylist(playlist);
    expect(await store.listPlaylists('a')).toEqual([playlist]);
    await store.deletePlaylist('p');
    expect(await store.listAllPlaylists()).toEqual([]);
  });

  it('stores metadata and analysis without requiring a track row', async () => {
    const metadata = {
      fileId: 'a:x.mp3', title: 'T', artists: ['A', 'B'], album: null, durationSeconds: 12.5,
      sizeBytes: 1234, lastModifiedMs: 99, parserVersion: 5, contentHash: 'abc',
    };
    await store.putMetadata(metadata);
    expect(await store.getMetadata('a:x.mp3')).toMatchObject(metadata);
    expect(await store.getMetadata('nope')).toBeNull();

    const analysis = { fileId: 'a:x.mp3', normalizationGain: 0.8, analyzedAtMs: 1, sizeBytes: 1234, lastModifiedMs: 99, algorithmVersion: 2 };
    await store.putAnalysis(analysis);
    expect(await store.getAnalysis('a:x.mp3')).toEqual(analysis);
  });

  it('serves cover art as a URL and removes it on null', async () => {
    expect(await store.getCoverArt('a:x.mp3')).toBeNull();
    await store.putCoverArt('a:x.mp3', { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) });
    expect(await store.getCoverArt('a:x.mp3')).toBe('/api/v1/tracks/a%3Ax.mp3/cover');
    await store.putCoverArt('a:x.mp3', null);
    expect(await store.getCoverArt('a:x.mp3')).toBeNull();
  });

  it('handles lyrics scopes, assignments and settings', async () => {
    await store.addLyricsScope({ rootId: 'a', relativePath: 'Lyrics' });
    await store.addLyricsScope({ rootId: 'a', relativePath: 'Lyrics' });
    expect(await store.getLyricsScopes()).toEqual([{ rootId: 'a', relativePath: 'Lyrics' }]);
    await store.removeLyricsScope('a', 'Lyrics');
    expect(await store.getLyricsScopes()).toEqual([]);

    expect(await store.getLyricsAssignment('t')).toBeNull();
    await store.putLyricsAssignment('t', 'l.lrc');
    expect(await store.getLyricsAssignment('t')).toBe('l.lrc');
    await store.putLyricsAssignment('t', null);
    expect(await store.getLyricsAssignment('t')).toBeNull();

    await store.putSetting('k', 'v1');
    await store.putSetting('k', 'v2');
    expect(await store.getSetting('k')).toBe('v2');
    expect(await store.getSetting('missing')).toBeNull();
  });
});

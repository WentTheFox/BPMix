import { describe, expect, it } from 'vitest';
import type { FileAccess, FileRef, GrantedRoot, DirectoryEntry } from '../file-access/types';
import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, RootKind, TrackRecord } from '../library-store/types';
import type { CoverArtBytes, TrackMetadata } from './types';
import type { CoverArtResizer } from './coverArtResizer';
import { encodeBase64 } from './base64';
import { COVER_ART_MAX_DIMENSION_PX, ensureTrackMetadata, isMetadataFresh, METADATA_PARSER_VERSION } from './ensureMetadata';

class FakeLibraryStore implements LibraryStore {
  metadata = new Map<string, TrackMetadata>();
  coverArt = new Map<string, string>();

  async upsertTrack(): Promise<void> {}
  async upsertPlaylist(): Promise<void> {}
  async listTracks(): Promise<TrackRecord[]> {
    return [];
  }
  async listPlaylists(): Promise<PlaylistRecord[]> {
    return [];
  }
  async getAnalysis(): Promise<AnalysisResult | null> {
    return null;
  }
  async putAnalysis(): Promise<void> {}
  async getMetadata(fileId: string): Promise<TrackMetadata | null> {
    return this.metadata.get(fileId) ?? null;
  }
  async putMetadata(result: TrackMetadata): Promise<void> {
    this.metadata.set(result.fileId, result);
  }
  async getCoverArt(fileId: string): Promise<string | null> {
    return this.coverArt.get(fileId) ?? null;
  }
  // Mimics a real adapter's own encoding step (see e.g. libraryStore.android.ts) - putCoverArt takes raw bytes, not a pre-encoded string.
  async putCoverArt(fileId: string, art: CoverArtBytes | null): Promise<void> {
    if (art === null) {
      this.coverArt.delete(fileId);
    } else {
      this.coverArt.set(fileId, `data:${art.mimeType};base64,${encodeBase64(art.data)}`);
    }
  }
  async getPlaybackState(): Promise<PlaybackState | null> {
    return null;
  }
  async putPlaybackState(): Promise<void> {}
  async getRootKind(): Promise<RootKind> {
    return 'music';
  }
  async setRootKind(): Promise<void> {}
  async getLyricsAssignment(): Promise<string | null> {
    return null;
  }
  async putLyricsAssignment(): Promise<void> {}
}

class FakeFileAccess implements FileAccess {
  constructor(private bytesByFileId: Map<string, ArrayBuffer>) {}

  async requestRoot(): Promise<GrantedRoot | null> {
    return null;
  }
  async listGrantedRoots(): Promise<GrantedRoot[]> {
    return [];
  }
  async revokeRoot(): Promise<void> {}
  async listDirectory(): Promise<DirectoryEntry[]> {
    return [];
  }
  async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
    const bytes = this.bytesByFileId.get(ref.id);
    if (!bytes) throw new Error(`no bytes for ${ref.id}`);
    return bytes;
  }
  async readFileText(): Promise<string> {
    return '';
  }
}

function synchsafe(size: number): number[] {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
}

/** Builds a minimal real ID3v2.3 tag (Latin-1 text frames, plus an optional APIC picture frame) followed by some filler "audio" bytes. */
function buildMp3WithId3v2(tags: {
  title?: string;
  artist?: string;
  album?: string;
  coverArt?: { mimeType: string; bytes: number[] };
}): ArrayBuffer {
  const frames: number[] = [];
  // Appends element-by-element rather than frames.push(...body) - a large
  // embedded image's body array (hundreds of thousands of elements, in the
  // size-cutoff tests below) blows the call stack when spread into push().
  const addFrame = (id: string, body: number[]) => {
    for (const c of Array.from(id)) frames.push(c.charCodeAt(0));
    frames.push((body.length >> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, 0, 0);
    for (const b of body) frames.push(b);
  };
  const addTextFrame = (id: string, text: string) => addFrame(id, [0, ...Array.from(text).map((c) => c.charCodeAt(0))]); // encoding byte 0 = Latin-1

  if (tags.title) addTextFrame('TIT2', tags.title);
  if (tags.artist) addTextFrame('TPE1', tags.artist);
  if (tags.album) addTextFrame('TALB', tags.album);
  if (tags.coverArt) {
    const mimeBytes = [...Array.from(tags.coverArt.mimeType).map((c) => c.charCodeAt(0)), 0]; // null-terminated
    const pictureType = 3; // "Cover (front)"
    addFrame('APIC', [0 /* encoding */, ...mimeBytes, pictureType, 0 /* empty null-terminated description */, ...tags.coverArt.bytes]);
  }

  const header = [0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(frames.length)];
  const filler = new Array(64).fill(0);
  return new Uint8Array([...header, ...frames, ...filler]).buffer;
}

const ref: FileRef = { id: 'a', name: 'a.mp3', relativePath: 'a.mp3', sizeBytes: 1000, lastModifiedMs: 5 };

describe('ensureTrackMetadata', () => {
  it('reads title/artist/album from a real ID3v2.3 tag and persists it', async () => {
    const store = new FakeLibraryStore();
    const bytes = buildMp3WithId3v2({ title: 'Song Title', artist: 'The Artist', album: 'Great Album' });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));

    const result = await ensureTrackMetadata(store, fileAccess, ref);

    expect(result.title).toBe('Song Title');
    expect(result.artists).toEqual(['The Artist']);
    expect(result.album).toBe('Great Album');
    expect(await store.getMetadata('a')).toEqual(result);
  });

  it('extracts embedded cover art as a data URI', async () => {
    const store = new FakeLibraryStore();
    const imageBytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02, 0x03]; // fake JPEG-ish bytes - content doesn't matter, just that they round-trip
    const bytes = buildMp3WithId3v2({ title: 'Song', coverArt: { mimeType: 'image/jpeg', bytes: imageBytes } });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));

    await ensureTrackMetadata(store, fileAccess, ref);
    const art = await store.getCoverArt('a');

    expect(art).toMatch(/^data:image\/jpeg;base64,/);
    const base64 = art!.split(',')[1]!;
    expect(Buffer.from(base64, 'base64')).toEqual(Buffer.from(imageBytes));
  });

  it('drops art over the size cutoff when no resizer is given', async () => {
    const store = new FakeLibraryStore();
    const bigImage = Array.from({ length: 600_000 }, (_, i) => i % 256);
    const bytes = buildMp3WithId3v2({ title: 'Song', coverArt: { mimeType: 'image/jpeg', bytes: bigImage } });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));

    await ensureTrackMetadata(store, fileAccess, ref);

    expect(await store.getCoverArt('a')).toBeNull();
  });

  it('asks the resizer to shrink art over the size cutoff, and stores the result', async () => {
    const store = new FakeLibraryStore();
    const bigImage = Array.from({ length: 600_000 }, (_, i) => i % 256);
    const bytes = buildMp3WithId3v2({ title: 'Song', coverArt: { mimeType: 'image/jpeg', bytes: bigImage } });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));
    const resizedBytes = new Uint8Array([9, 9, 9]);
    let calledWith: { mimeType: string; length: number; maxDimensionPx: number } | null = null;
    const resizer: CoverArtResizer = {
      async resize(data, mimeType, maxDimensionPx) {
        calledWith = { mimeType, length: data.length, maxDimensionPx };
        return { mimeType: 'image/jpeg', bytes: resizedBytes };
      },
    };

    await ensureTrackMetadata(store, fileAccess, ref, resizer);
    const art = await store.getCoverArt('a');

    expect(calledWith).toEqual({ mimeType: 'image/jpeg', length: 600_000, maxDimensionPx: COVER_ART_MAX_DIMENSION_PX });
    expect(art).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(art!.split(',')[1]!, 'base64')).toEqual(Buffer.from(resizedBytes));
  });

  it('still drops art if the resizer declines (returns null) and the original is over the cutoff', async () => {
    const store = new FakeLibraryStore();
    const bigImage = Array.from({ length: 600_000 }, (_, i) => i % 256);
    const bytes = buildMp3WithId3v2({ title: 'Song', coverArt: { mimeType: 'image/jpeg', bytes: bigImage } });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));
    const resizer: CoverArtResizer = { async resize() { return null; } };

    await ensureTrackMetadata(store, fileAccess, ref, resizer);

    expect(await store.getCoverArt('a')).toBeNull();
  });

  it('does not call the resizer for art already under the size cutoff', async () => {
    const store = new FakeLibraryStore();
    const bytes = buildMp3WithId3v2({ title: 'Song', coverArt: { mimeType: 'image/jpeg', bytes: [1, 2, 3] } });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));
    let called = false;
    const resizer: CoverArtResizer = { async resize() { called = true; return null; } };

    await ensureTrackMetadata(store, fileAccess, ref, resizer);

    expect(called).toBe(false);
    expect(await store.getCoverArt('a')).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('clears previously stored art when a re-scanned file no longer has any', async () => {
    const store = new FakeLibraryStore();
    const withArt = buildMp3WithId3v2({ title: 'Song', coverArt: { mimeType: 'image/png', bytes: [1, 2, 3] } });
    await ensureTrackMetadata(store, new FakeFileAccess(new Map([['a', withArt]])), ref);
    expect(await store.getCoverArt('a')).not.toBeNull();

    const withoutArt = buildMp3WithId3v2({ title: 'Song' });
    const changedRef: FileRef = { ...ref, sizeBytes: 2000, lastModifiedMs: 42 };
    await ensureTrackMetadata(store, new FakeFileAccess(new Map([['a', withoutArt]])), changedRef);

    expect(await store.getCoverArt('a')).toBeNull();
  });

  it('splits a "/"-delimited multi-artist frame into individual names', async () => {
    const store = new FakeLibraryStore();
    const bytes = buildMp3WithId3v2({ title: 'Song', artist: 'Artist One/Artist Two' });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));

    const result = await ensureTrackMetadata(store, fileAccess, ref);

    expect(result.artists).toEqual(['Artist One', 'Artist Two']);
  });

  it('persists a "scanned, no tags" result (not null) for a file with no ID3 tag, so callers can tell it apart from "not scanned yet"', async () => {
    const store = new FakeLibraryStore();
    const fileAccess = new FakeFileAccess(new Map([['a', new Uint8Array(64).buffer]]));

    const result = await ensureTrackMetadata(store, fileAccess, ref);

    expect(result.title).toBeNull();
    expect(result.artists).toEqual([]);
    expect(result.album).toBeNull();
    expect(await store.getMetadata('a')).toEqual(result);
  });

  it('returns the cached result without re-reading the file when size/mtime match', async () => {
    const store = new FakeLibraryStore();
    const bytes = buildMp3WithId3v2({ title: 'Song' });
    const fileAccess = new FakeFileAccess(new Map([['a', bytes]]));
    const first = await ensureTrackMetadata(store, fileAccess, ref);

    // A file access that throws proves the cache hit skipped reading entirely, not just returned an equal-by-luck result.
    const throwingFileAccess = new FakeFileAccess(new Map());
    const second = await ensureTrackMetadata(store, throwingFileAccess, ref);

    expect(second).toEqual(first);
  });

  it('re-reads when the file has changed (different size/mtime)', async () => {
    const store = new FakeLibraryStore();
    const fileAccess = new FakeFileAccess(
      new Map([
        ['a', buildMp3WithId3v2({ title: 'Old Title' })],
      ]),
    );
    await ensureTrackMetadata(store, fileAccess, ref);

    const changedRef: FileRef = { ...ref, sizeBytes: 2000, lastModifiedMs: 42 };
    const changedFileAccess = new FakeFileAccess(new Map([['a', buildMp3WithId3v2({ title: 'New Title' })]]));
    const result = await ensureTrackMetadata(store, changedFileAccess, changedRef);

    expect(result.title).toBe('New Title');
    expect(result.sizeBytes).toBe(2000);
    expect(result.lastModifiedMs).toBe(42);
  });

  it('isMetadataFresh is false for a result from an older parser version even though size/mtime still match', () => {
    const stale: TrackMetadata = {
      fileId: 'a',
      title: 'x',
      artists: [],
      album: null,
      sizeBytes: 1000,
      lastModifiedMs: 5,
      parserVersion: METADATA_PARSER_VERSION - 1,
    };
    expect(isMetadataFresh(stale, ref)).toBe(false);
  });
});

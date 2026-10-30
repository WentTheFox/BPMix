import { describe, expect, it } from 'vitest';
import type { FileAccess } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import { matchLibraryLyrics } from './matchLibraryLyrics';

const track: TrackRecord = { fileId: 'r:a.mp3', rootId: 'r', relativePath: 'a.mp3', sizeBytes: 1, lastModifiedMs: 1 };

describe('matchLibraryLyrics', () => {
  it('rejects instead of hanging when a lyrics scope cannot be listed', async () => {
    const fileAccess = {
      listDirectory: async () => {
        throw new Error('No library root "Lyrics"');
      },
    } as unknown as FileAccess;

    await expect(matchLibraryLyrics(fileAccess, {} as LibraryStore, [{ rootId: 'Lyrics', relativePath: '' }], [track])).rejects.toThrow(
      'No library root "Lyrics"',
    );
  });

  it('rejects when persisting a match fails', async () => {
    const fileAccess = {
      listDirectory: async () => [{ type: 'file', name: 'a.lrc', relativePath: 'a.lrc', file: { id: 'L:a.lrc', name: 'a.lrc', relativePath: 'a.lrc', sizeBytes: 1, lastModifiedMs: 1 } }],
    } as unknown as FileAccess;
    const store = {
      putSetting: async () => {},
      getLyricsAssignment: async () => null,
      putLyricsAssignment: async () => {
        throw new Error('disk on fire');
      },
    } as unknown as LibraryStore;

    await expect(matchLibraryLyrics(fileAccess, store, [{ rootId: 'L', relativePath: '' }], [track])).rejects.toThrow('disk on fire');
  });

  it('resolves immediately with nothing to match', async () => {
    await expect(matchLibraryLyrics({} as FileAccess, {} as LibraryStore, [], [track])).resolves.toBeUndefined();
  });
});

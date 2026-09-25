import type { TrackMetadata, TrackRecord } from '@bpmix/core';
import { createLibraryStore } from '../src/adapters/libraryStore.windows';

// jest.mock below is hoisted above these imports by babel-jest, so the
// store module sees the fake native module when it loads.
//
// In-memory stand-in for the BPMixLocalStorage native module - each call
// takes a macrotask, like the real WinRT file I/O, so concurrent callers
// genuinely overlap.
const mockFiles = new Map<string, string>();
const mockStats = { writes: 0 };
jest.mock('react-native', () => ({
  NativeModules: {
    BPMixLocalStorage: {
      readText: (name: string) => new Promise((resolve) => setTimeout(() => resolve(mockFiles.get(name) ?? null), 0)),
      writeText: (name: string, content: string) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            mockStats.writes++;
            mockFiles.set(name, content);
            resolve();
          }, 0),
        ),
    },
  },
}));

function track(i: number): TrackRecord {
  return { fileId: `f${i}`, rootId: 'root', relativePath: `t${i}.mp3`, sizeBytes: 1, lastModifiedMs: 0 };
}

describe('Windows library store', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockStats.writes = 0;
  });

  it('keeps every one of many concurrent writes (no lost read-modify-write updates) and batches them into few file writes', async () => {
    const store = createLibraryStore();

    await Promise.all([
      ...Array.from({ length: 500 }, (_, i) => store.upsertTrack(track(i))),
      ...Array.from({ length: 50 }, (_, i) => store.putMetadata({ fileId: `f${i}`, title: `Song ${i}` } as TrackMetadata)),
    ]);

    // A fresh instance reads what's actually on disk, not the first one's cache.
    const reloaded = createLibraryStore();
    expect(await reloaded.listTracks('root')).toHaveLength(500);
    expect((await reloaded.getMetadata('f49'))?.title).toBe('Song 49');
    // Previously one full-file write per call (550).
    expect(mockStats.writes).toBeLessThanOrEqual(3);
  });
});

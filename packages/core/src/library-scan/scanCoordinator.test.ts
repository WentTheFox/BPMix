import { describe, expect, it, vi } from 'vitest';
import type { DirectoryEntry, FileAccess, GrantedRoot } from '../file-access/types';
import type {
  AnalysisResult,
  LibraryStore,
  LyricsScope,
  PlaybackState,
  PlaylistRecord,
  TrackRecord,
} from '../library-store/types';
import type { TrackMetadata } from '../metadata/types';
import {
  cancelRootScan,
  getActiveScanRootIds,
  isRootScanning,
  scanRootCoordinated,
  subscribeScanning,
} from './scanCoordinator';
import { getTasks } from '../tasks/taskQueue';
import { ScanCancelledError } from './walk';

/** A FileAccess whose listDirectory never resolves until released() is called - lets a test hold a scan open to exercise de-dup/cancel behavior deterministically instead of racing real timers. */
class HangingFileAccess implements FileAccess {
  private releaseFns: (() => void)[] = [];
  callCount = 0;

  release(): void {
    for (const fn of this.releaseFns.splice(0)) fn();
  }

  async requestRoot(): Promise<GrantedRoot | null> {
    throw new Error('not used in this test');
  }
  async listGrantedRoots(): Promise<GrantedRoot[]> {
    return [];
  }
  async revokeRoot(): Promise<void> {}

  async listDirectory(): Promise<DirectoryEntry[]> {
    this.callCount++;
    await new Promise<void>((resolve) => this.releaseFns.push(resolve));
    return [];
  }

  async readFileBytes(): Promise<ArrayBuffer> {
    throw new Error('not used in this test');
  }
  async readFileText(): Promise<string> {
    throw new Error('not used in this test');
  }
  async writeFileText(): Promise<void> {
    throw new Error('not used in this test');
  }
}

class FakeLibraryStore implements LibraryStore {
  tracks = new Map<string, TrackRecord>();
  playlists = new Map<string, PlaylistRecord>();
  analysis = new Map<string, AnalysisResult>();
  playbackState: PlaybackState | null = null;

  async upsertTrack(track: TrackRecord): Promise<void> {
    this.tracks.set(track.fileId, track);
  }
  async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
    this.playlists.set(playlist.id, playlist);
  }
  async listTracks(rootId: string): Promise<TrackRecord[]> {
    return [...this.tracks.values()].filter((t) => t.rootId === rootId);
  }
  async listPlaylists(rootId: string): Promise<PlaylistRecord[]> {
    return [...this.playlists.values()].filter((p) => p.rootId === rootId);
  }
  async getAnalysis(): Promise<AnalysisResult | null> {
    return null;
  }
  async putAnalysis(): Promise<void> {}
  async getMetadata(): Promise<TrackMetadata | null> {
    return null;
  }
  async putMetadata(): Promise<void> {}
  async getCoverArt(): Promise<string | null> {
    return null;
  }
  async putCoverArt(): Promise<void> {}
  async getPlaybackState(): Promise<PlaybackState | null> {
    return this.playbackState;
  }
  async putPlaybackState(state: PlaybackState): Promise<void> {
    this.playbackState = state;
  }
  async getLyricsScopes(): Promise<LyricsScope[]> {
    return [];
  }
  async addLyricsScope(): Promise<void> {}
  async removeLyricsScope(): Promise<void> {}
  async getLyricsAssignment(): Promise<string | null> {
    return null;
  }
  async putLyricsAssignment(): Promise<void> {}
  async getSetting(): Promise<string | null> {
    return null;
  }
  async putSetting(): Promise<void> {}
}

describe('scanRootCoordinated', () => {
  it('joins an already-in-flight scan of the same root instead of starting a second one', async () => {
    const fileAccess = new HangingFileAccess();
    const store = new FakeLibraryStore();

    const first = scanRootCoordinated(fileAccess, store, 'root-1');
    const second = scanRootCoordinated(fileAccess, store, 'root-1');

    // The scan starts once the task queue grants it its turn - a tick later.
    await vi.waitFor(() => expect(fileAccess.callCount).toBe(1)); // only one real walk started, not two
    expect(isRootScanning('root-1')).toBe(true);

    fileAccess.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult); // both callers got the exact same result
    expect(isRootScanning('root-1')).toBe(false);
  });

  it('queues a different root scan behind the running one instead of joining it or racing it', async () => {
    const fileAccess = new HangingFileAccess();
    const store = new FakeLibraryStore();

    const first = scanRootCoordinated(fileAccess, store, 'root-1');
    const second = scanRootCoordinated(fileAccess, store, 'root-2');

    await vi.waitFor(() => expect(fileAccess.callCount).toBe(1));
    // Both count as scanning (the second is queued), but only one walks.
    expect(getActiveScanRootIds().sort()).toEqual(['root-1', 'root-2']);
    expect(fileAccess.callCount).toBe(1);

    fileAccess.release();
    await first;
    await vi.waitFor(() => expect(fileAccess.callCount).toBe(2));
    fileAccess.release();
    await second;
  });

  it('cancelling a still-queued scan settles it right away, without waiting for the scan ahead of it', async () => {
    const fileAccess = new HangingFileAccess();
    const store = new FakeLibraryStore();

    const first = scanRootCoordinated(fileAccess, store, 'root-1');
    const queued = scanRootCoordinated(fileAccess, store, 'root-2');
    await vi.waitFor(() => expect(fileAccess.callCount).toBe(1));

    cancelRootScan('root-2');
    await expect(queued).rejects.toThrow(ScanCancelledError);
    expect(fileAccess.callCount).toBe(1); // root-2 never walked

    fileAccess.release();
    await first;
  });

  it('cancelRootScan aborts the in-flight scan and rejects every joined caller with ScanCancelledError', async () => {
    const fileAccess = new HangingFileAccess();
    const store = new FakeLibraryStore();

    const first = scanRootCoordinated(fileAccess, store, 'root-1');
    const second = scanRootCoordinated(fileAccess, store, 'root-1');

    cancelRootScan('root-1');
    fileAccess.release(); // the hung listDirectory call still has to resolve for the abort check after it to run

    await expect(first).rejects.toThrow(ScanCancelledError);
    await expect(second).rejects.toThrow(ScanCancelledError);
    expect(isRootScanning('root-1')).toBe(false);
  });

  it('cancelRootScan is a no-op if the root is not currently scanning', () => {
    expect(() => cancelRootScan('never-scanned-root')).not.toThrow();
  });

  it('notifies subscribers when a scan starts and finishes', async () => {
    const fileAccess = new HangingFileAccess();
    const store = new FakeLibraryStore();
    const listener = vi.fn();
    const unsubscribe = subscribeScanning(listener);

    const promise = scanRootCoordinated(fileAccess, store, 'root-1');
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(fileAccess.callCount).toBe(1));
    fileAccess.release();
    await promise;
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('runs as a labelled, cancellable foreground task on the shared queue, gone from it once finished', async () => {
    const fileAccess = new HangingFileAccess();
    const store = new FakeLibraryStore();

    const promise = scanRootCoordinated(fileAccess, store, 'root-1', 'My Music');
    const task = getTasks().find((t) => t.id === 'scanning-root-1');
    expect(task).toMatchObject({ label: 'Scanning "My Music"', priority: 'foreground' });
    expect(task?.cancel).toBeTypeOf('function');

    // Let the queued task start and reach its first (hanging) listing.
    await vi.waitFor(() => expect(fileAccess.callCount).toBe(1));
    fileAccess.release();
    await promise;
    expect(getTasks().some((t) => t.id === 'scanning-root-1')).toBe(false);
  });
});

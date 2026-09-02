import { describe, expect, it } from 'vitest';
import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import { analyzeLibrary } from './analyzeLibrary';

class FakeAudioEngine implements AudioEngine {
  decodedRefIds: string[] = [];
  failFor = new Set<string>();

  async decodeFile(ref: FileRef): Promise<DecodedAudio> {
    this.decodedRefIds.push(ref.id);
    if (this.failFor.has(ref.id)) {
      throw new Error(`decode failed for ${ref.id}`);
    }
    // Enough real (loud) samples that analysis has something to chew on -
    // content correctness isn't what these tests are checking.
    const length = 44100 * 5;
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    return { sampleRate: 44100, numberOfChannels: 1, channelData: [samples], durationSeconds: 5 };
  }
  createSource(): SourceNode {
    throw new Error('not used in this test');
  }
  scheduleStart(): void {
    throw new Error('not used in this test');
  }
  now(): number {
    return 0;
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
  async getAnalysis(fileId: string): Promise<AnalysisResult | null> {
    return this.analysis.get(fileId) ?? null;
  }
  async putAnalysis(result: AnalysisResult): Promise<void> {
    this.analysis.set(result.fileId, result);
  }
  async getPlaybackState(): Promise<PlaybackState | null> {
    return this.playbackState;
  }
  async putPlaybackState(state: PlaybackState): Promise<void> {
    this.playbackState = state;
  }
}

function track(overrides: Partial<TrackRecord> & { fileId: string }): TrackRecord {
  return { rootId: 'root1', relativePath: `${overrides.fileId}.mp3`, sizeBytes: 1000, lastModifiedMs: 1, ...overrides };
}

function existingAnalysis(overrides: Partial<AnalysisResult> & { fileId: string }): AnalysisResult {
  return {
    startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 },
    endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 },
    normalizationGain: 1,
    analyzedAtMs: 0,
    sizeBytes: 1000,
    lastModifiedMs: 1,
    ...overrides,
  };
}

describe('analyzeLibrary', () => {
  it('analyzes a new track that has never been analyzed', async () => {
    const engine = new FakeAudioEngine();
    const store = new FakeLibraryStore();
    const t = track({ fileId: 'a' });

    await analyzeLibrary(engine, store, [t]);

    expect(engine.decodedRefIds).toEqual(['a']);
    const result = await store.getAnalysis('a');
    expect(result).not.toBeNull();
    expect(result!.sizeBytes).toBe(1000);
    expect(result!.lastModifiedMs).toBe(1);
  });

  it('skips a track whose stored analysis already matches its current size/mtime', async () => {
    const engine = new FakeAudioEngine();
    const store = new FakeLibraryStore();
    const t = track({ fileId: 'a', sizeBytes: 2000, lastModifiedMs: 5 });
    store.analysis.set('a', existingAnalysis({ fileId: 'a', sizeBytes: 2000, lastModifiedMs: 5 }));

    const progress: boolean[] = [];
    await analyzeLibrary(engine, store, [t], { onProgress: (p) => progress.push(p.skipped) });

    expect(engine.decodedRefIds).toEqual([]);
    expect(progress).toEqual([true]);
  });

  it('re-analyzes a track whose file changed since its last analysis', async () => {
    const engine = new FakeAudioEngine();
    const store = new FakeLibraryStore();
    // Same fileId (path-based identity - editing a file in place doesn't change it),
    // but size/mtime moved on, so the stored analysis is stale.
    const t = track({ fileId: 'a', sizeBytes: 9999, lastModifiedMs: 42 });
    store.analysis.set('a', existingAnalysis({ fileId: 'a', sizeBytes: 1000, lastModifiedMs: 1 }));

    await analyzeLibrary(engine, store, [t]);

    expect(engine.decodedRefIds).toEqual(['a']);
    const result = await store.getAnalysis('a');
    expect(result!.sizeBytes).toBe(9999);
    expect(result!.lastModifiedMs).toBe(42);
  });

  it('only analyzes the one new/changed track, leaving unchanged ones untouched', async () => {
    const engine = new FakeAudioEngine();
    const store = new FakeLibraryStore();
    store.analysis.set('unchanged', existingAnalysis({ fileId: 'unchanged', sizeBytes: 1000, lastModifiedMs: 1 }));

    const tracks = [
      track({ fileId: 'unchanged', sizeBytes: 1000, lastModifiedMs: 1 }),
      track({ fileId: 'new-one', sizeBytes: 1000, lastModifiedMs: 1 }),
    ];

    await analyzeLibrary(engine, store, tracks);

    expect(engine.decodedRefIds).toEqual(['new-one']);
  });

  it('reports a per-track error via onProgress instead of aborting the whole run', async () => {
    const engine = new FakeAudioEngine();
    engine.failFor.add('bad');
    const store = new FakeLibraryStore();
    const tracks = [track({ fileId: 'bad' }), track({ fileId: 'good' })];

    const errors: unknown[] = [];
    await analyzeLibrary(engine, store, tracks, {
      onProgress: (p) => {
        if (p.error) errors.push(p.error);
      },
    });

    expect(errors).toHaveLength(1);
    expect(await store.getAnalysis('bad')).toBeNull();
    expect(await store.getAnalysis('good')).not.toBeNull();
  });
});

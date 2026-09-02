import { describe, expect, it } from 'vitest';
import type { DecodedAudio } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import { ANALYSIS_ALGORITHM_VERSION } from './analyzeTrack';
import { ensureTrackAnalyzed } from './ensureAnalyzed';

class FakeLibraryStore implements LibraryStore {
  analysis = new Map<string, AnalysisResult>();

  async upsertTrack(): Promise<void> {}
  async upsertPlaylist(): Promise<void> {}
  async listTracks(): Promise<TrackRecord[]> {
    return [];
  }
  async listPlaylists(): Promise<PlaylistRecord[]> {
    return [];
  }
  async getAnalysis(fileId: string): Promise<AnalysisResult | null> {
    return this.analysis.get(fileId) ?? null;
  }
  async putAnalysis(result: AnalysisResult): Promise<void> {
    this.analysis.set(result.fileId, result);
  }
  async getPlaybackState(): Promise<PlaybackState | null> {
    return null;
  }
  async putPlaybackState(): Promise<void> {}
}

const ref: FileRef = { id: 'a', name: 'a.mp3', relativePath: 'a.mp3', sizeBytes: 1000, lastModifiedMs: 5 };

function tone(durationSeconds: number, sampleRate = 44100): Float32Array {
  const length = Math.round(durationSeconds * sampleRate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  return out;
}

function decodedAudio(): DecodedAudio {
  return { sampleRate: 44100, numberOfChannels: 1, channelData: [tone(5)], durationSeconds: 5 };
}

describe('ensureTrackAnalyzed', () => {
  it('analyzes and persists a track with no existing analysis', async () => {
    const store = new FakeLibraryStore();

    const result = await ensureTrackAnalyzed(store, ref, decodedAudio());

    expect(result.fileId).toBe('a');
    expect(result.sizeBytes).toBe(1000);
    expect(result.lastModifiedMs).toBe(5);
    expect(await store.getAnalysis('a')).toEqual(result);
  });

  it('returns the cached result without re-analyzing when size/mtime match', async () => {
    const store = new FakeLibraryStore();
    const first = await ensureTrackAnalyzed(store, ref, decodedAudio());

    const second = await ensureTrackAnalyzed(store, ref, decodedAudio());

    expect(second).toEqual(first);
    expect(second.analyzedAtMs).toBe(first.analyzedAtMs); // proves it wasn't recomputed, not just coincidentally equal
  });

  it('re-analyzes when the file has changed (different size/mtime)', async () => {
    const store = new FakeLibraryStore();
    await ensureTrackAnalyzed(store, ref, decodedAudio());

    const changedRef: FileRef = { ...ref, sizeBytes: 2000, lastModifiedMs: 42 };
    const result = await ensureTrackAnalyzed(store, changedRef, decodedAudio());

    expect(result.sizeBytes).toBe(2000);
    expect(result.lastModifiedMs).toBe(42);
  });

  it('re-analyzes a cached result from an older algorithm version even though size/mtime still match (regression: an algorithm fix must apply to already-analyzed files, not just newly-changed ones)', async () => {
    const store = new FakeLibraryStore();
    const first = await ensureTrackAnalyzed(store, ref, decodedAudio());
    await store.putAnalysis({ ...first, algorithmVersion: first.algorithmVersion - 1, analyzedAtMs: 1 });

    const second = await ensureTrackAnalyzed(store, ref, decodedAudio());

    expect(second.algorithmVersion).toBe(ANALYSIS_ALGORITHM_VERSION);
    expect(second.analyzedAtMs).not.toBe(1); // proves it was actually recomputed, not just returned as-is
  });
});

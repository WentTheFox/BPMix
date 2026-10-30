import { vi } from 'vitest';
import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import type { CoverArtBytes, TrackMetadata } from '../metadata/types';

/** An in-memory LibraryStore, enough for what ServerMode touches. */
export class MemoryStore implements LibraryStore {
  tracks = new Map<string, TrackRecord>();
  playlists = new Map<string, PlaylistRecord>();
  metadata = new Map<string, TrackMetadata>();
  analysis = new Map<string, AnalysisResult>();
  covers = new Map<string, string>();
  settings = new Map<string, string>();

  async upsertTrack(t: TrackRecord) { this.tracks.set(t.fileId, t); }
  async deleteTrack(id: string) { this.tracks.delete(id); this.metadata.delete(id); this.analysis.delete(id); }
  async upsertPlaylist(p: PlaylistRecord) { this.playlists.set(p.id, p); }
  async deletePlaylist(id: string) { this.playlists.delete(id); }
  async listTracks(rootId: string) { return [...this.tracks.values()].filter((t) => t.rootId === rootId); }
  async listPlaylists(rootId: string) { return [...this.playlists.values()].filter((p) => p.rootId === rootId); }
  async listAllTracks() { return [...this.tracks.values()]; }
  async listAllPlaylists() { return [...this.playlists.values()]; }
  async getAnalysis(id: string) { return this.analysis.get(id) ?? null; }
  async putAnalysis(a: AnalysisResult) { this.analysis.set(a.fileId, a); }
  async getMetadata(id: string) { return this.metadata.get(id) ?? null; }
  async putMetadata(m: TrackMetadata) { this.metadata.set(m.fileId, m); }
  async getCoverArt(id: string) { return this.covers.get(id) ?? null; }
  async putCoverArt(id: string, art: CoverArtBytes | null) {
    if (art) this.covers.set(id, `file://${id}.${art.mimeType.split('/')[1]}`);
    else this.covers.delete(id);
  }
  async getPlaybackState(): Promise<PlaybackState | null> { return null; }
  async putPlaybackState() {}
  async getLyricsScopes() { return []; }
  async addLyricsScope() {}
  async removeLyricsScope() {}
  lyricsAssignments = new Map<string, string | null>();
  async getLyricsAssignment(fileId: string) { return this.lyricsAssignments.get(fileId) ?? null; }
  async putLyricsAssignment(fileId: string, lrcFileId: string | null) { this.lyricsAssignments.set(fileId, lrcFileId); }
  async getSetting(key: string) { return this.settings.get(key) ?? null; }
  async putSetting(key: string, value: string) { this.settings.set(key, value); }
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A scriptable server: tests set `handler`; everything else about fetch is recorded. */
export function fakeServer() {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const server = {
    calls,
    handler: (_path: string, _init: RequestInit | undefined): Response | Promise<Response> => json({ message: 'not scripted' }, 500),
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://this.site'); // relative, like a page on the server itself
      calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, auth: new Headers(init?.headers).get('authorization') });
      return server.handler(url.pathname + url.search, init);
    }) as unknown as typeof fetch,
  };
  return server;
}


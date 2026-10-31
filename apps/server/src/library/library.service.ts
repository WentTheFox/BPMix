import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { encodeTrackKey, type ListTracksQuery, type LyricsDto, type LyricsSaveRequestDto, type LyricsSourceDto, type Page, type PlaylistDto, type RootDto, type TrackDto } from '@bpmix/api';
import { formatLrc, getLyricsFileIndex, loadAssignedLyrics, parseLrc, resolveAssignedLyricsFile } from '@bpmix/core';
import { DatabaseService } from '../db/database.module.js';
import { Prisma } from '../generated/prisma/client.js';
import { FILE_ACCESS, type NodeFileAccess } from '../node/node.module.js';
import { Inject } from '@nestjs/common';

interface TrackRow {
  file_id: string;
  root_id: string;
  relative_path: string;
  size_bytes: bigint;
  last_modified_ms: number;
  missing: boolean;
  title: string | null;
  artists: string[] | null;
  album: string | null;
  duration_seconds: number | null;
  content_hash: string | null;
  normalization_gain: number | null;
  has_cover: boolean;
  has_lyrics: boolean;
}

function toTrackDto(row: TrackRow): TrackDto {
  return {
    id: encodeTrackKey(row.file_id),
    rootId: row.root_id,
    relativePath: row.relative_path,
    sizeBytes: Number(row.size_bytes),
    lastModifiedMs: row.last_modified_ms,
    missing: row.missing,
    title: row.title,
    artists: row.artists ?? [],
    album: row.album,
    durationSeconds: row.duration_seconds,
    contentHash: row.content_hash,
    normalizationGain: row.normalization_gain,
    hasCover: row.has_cover,
    hasLyrics: row.has_lyrics,
  };
}

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Read-side queries over the scanned library, shaped as the v1 API's DTOs. */
@Injectable()
export class LibraryService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(FILE_ACCESS) private readonly fileAccess: NodeFileAccess,
  ) {}

  /** The track's lyrics, parsed and merged with its translation sibling by the same code the apps used to run themselves. */
  async getLyrics(fileId: string): Promise<LyricsDto | null> {
    const store = this.db.libraryStore;
    const scopes = await store.getLyricsScopes();
    const lyrics = scopes.length > 0 ? await loadAssignedLyrics(this.fileAccess, store, scopes, fileId) : null;
    if (lyrics) return { synced: lyrics.synced, tags: lyrics.tags, lines: lyrics.lines };
    // No linked .lrc file: fall back to what the audio file carries itself (read at scan time).
    const embedded = await this.db.prisma.embeddedLyrics.findUnique({ where: { fileId }, select: { text: true } });
    if (!embedded?.text) return null;
    const parsed = parseLrc(embedded.text);
    return { synced: parsed.synced, tags: parsed.tags, lines: parsed.lines };
  }

  private async lyricsScopes() {
    const scopes = await this.db.libraryStore.getLyricsScopes();
    if (scopes.length === 0) throw new ConflictException({ code: 'no_lyrics_folder', message: 'This server has no lyrics folder (see BPMIX_LYRICS_ROOTS)' });
    return scopes;
  }

  private async assertTrack(fileId: string): Promise<void> {
    if (!(await this.db.prisma.track.findUnique({ where: { fileId }, select: { fileId: true } }))) throw new NotFoundException('No such track');
  }

  /** What an admin picks from when linking a lyrics file: the one assigned now, and every candidate. */
  async lyricsSource(fileId: string): Promise<LyricsSourceDto> {
    await this.assertTrack(fileId);
    const store = this.db.libraryStore;
    const scopes = await this.lyricsScopes();
    const [files, assigned] = await Promise.all([getLyricsFileIndex(this.fileAccess, store, scopes), store.getLyricsAssignment(fileId)]);
    return { assigned, candidates: files.map((f) => ({ id: f.id, name: f.name, relativePath: f.relativePath, rootId: f.rootId })) };
  }

  /** Links the track to one of the lyrics files the server knows (or, with null, unlinks it). */
  async assignLyrics(fileId: string, lrcFileId: string | null): Promise<void> {
    await this.assertTrack(fileId);
    const store = this.db.libraryStore;
    if (lrcFileId !== null) {
      const files = await getLyricsFileIndex(this.fileAccess, store, await this.lyricsScopes());
      if (!files.some((f) => f.id === lrcFileId)) throw new NotFoundException('No such lyrics file');
    }
    await store.putLyricsAssignment(fileId, lrcFileId);
  }

  /** Writes hand-synced or hand-edited lines back to the track's assigned .lrc, keeping the file's own tags ([lang:pt] and the like). */
  async saveLyrics(fileId: string, lines: LyricsSaveRequestDto['lines']): Promise<void> {
    await this.assertTrack(fileId);
    const store = this.db.libraryStore;
    const resolved = await resolveAssignedLyricsFile(this.fileAccess, store, await this.lyricsScopes(), fileId);
    if (!resolved) throw new ConflictException({ code: 'no_lyrics_assigned', message: 'This track has no lyrics file to save into; link one first' });
    const tags = parseLrc(await this.fileAccess.readFileText(resolved.file)).tags;
    try {
      await this.fileAccess.writeFileText(resolved.rootId, resolved.file.relativePath, formatLrc(lines, tags));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        throw new ConflictException({ code: 'lyrics_read_only', message: 'The server\'s lyrics folder is read-only; mount it writable to edit lyrics' });
      }
      throw err;
    }
  }

  async listRoots(): Promise<RootDto[]> {
    const roots = await this.fileAccess.listGrantedRoots();
    return roots.map((r) => ({ id: r.id, displayName: r.displayName, kind: r.kind ?? 'library' }));
  }

  /** Keyset-paginated by file id, so a page boundary stays stable while a scan adds or removes rows. */
  async listTracks(query: ListTracksQuery): Promise<Page<TrackDto>> {
    const where: Prisma.Sql[] = [];
    if (query.rootId) where.push(Prisma.sql`t.root_id = ${query.rootId}`);
    if (query.cursor) where.push(Prisma.sql`t.file_id > ${query.cursor}`);
    if (query.q) {
      const pattern = likePattern(query.q);
      where.push(Prisma.sql`(t.relative_path ILIKE ${pattern} OR m.title ILIKE ${pattern} OR m.album ILIKE ${pattern} OR array_to_string(m.artists, ' ') ILIKE ${pattern})`);
    }
    const rows = await this.queryTracks(where, query.limit + 1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    return { items: items.map(toTrackDto), nextCursor: hasMore ? items[items.length - 1]!.file_id : null };
  }

  /** Several tracks at once, by file id; ids that don't exist are simply absent from the result. */
  async getTracksByFileIds(fileIds: string[]): Promise<Map<string, TrackDto>> {
    if (fileIds.length === 0) return new Map();
    const rows = await this.queryTracks([Prisma.sql`t.file_id = ANY(${fileIds}::text[])`], fileIds.length);
    return new Map(rows.map((row) => [row.file_id, toTrackDto(row)]));
  }

  async getPlaylistsByIds(ids: string[]): Promise<Map<string, PlaylistDto>> {
    const playlists = await this.db.prisma.playlist.findMany({ where: { id: { in: ids } } });
    return new Map(playlists.map((p) => [p.id, toPlaylistDto(p)]));
  }

  /** Playlists after `afterId` in id order (keyset paging), as file ids + DTOs. */
  async playlistsAfter(afterId: string | null, limit: number): Promise<{ id: string; dto: PlaylistDto }[]> {
    const playlists = await this.db.prisma.playlist.findMany({
      where: afterId === null ? {} : { id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return playlists.map((p) => ({ id: p.id, dto: toPlaylistDto(p) }));
  }

  async getTrack(fileId: string): Promise<TrackDto | null> {
    const [row] = await this.queryTracks([Prisma.sql`t.file_id = ${fileId}`], 1);
    return row ? toTrackDto(row) : null;
  }

  /** Real path of a playable track's audio, or null if it's unknown or only a missing placeholder. */
  async resolveAudioPath(fileId: string): Promise<string | null> {
    const track = await this.db.prisma.track.findUnique({ where: { fileId } });
    if (!track || track.missing) return null;
    return this.fileAccess.absolutePathOf({
      id: track.fileId,
      name: track.relativePath.split('/').pop() ?? track.relativePath,
      relativePath: track.relativePath,
      sizeBytes: Number(track.sizeBytes),
      lastModifiedMs: track.lastModifiedMs,
    });
  }

  getCover(fileId: string): Promise<{ mimeType: string; data: Uint8Array } | null> {
    return this.db.prisma.coverArt.findUnique({ where: { fileId } });
  }

  async listPlaylists(rootId?: string): Promise<PlaylistDto[]> {
    const playlists = await this.db.prisma.playlist.findMany({ where: rootId ? { rootId } : {}, orderBy: { id: 'asc' } });
    return playlists.map((p) => toPlaylistDto(p));
  }

  async getPlaylist(id: string): Promise<PlaylistDto | null> {
    const playlist = await this.db.prisma.playlist.findUnique({ where: { id } });
    return playlist ? toPlaylistDto(playlist) : null;
  }

  private queryTracks(where: Prisma.Sql[], limit: number): Promise<TrackRow[]> {
    const clause = where.length > 0 ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
    return this.db.prisma.$queryRaw<TrackRow[]>`
      SELECT t.file_id, t.root_id, t.relative_path, t.size_bytes, t.last_modified_ms, t.missing,
             m.title, m.artists, m.album, m.duration_seconds, m.content_hash,
             a.normalization_gain,
             (c.file_id IS NOT NULL) AS has_cover,
             (l.lrc_file_id IS NOT NULL OR e.text IS NOT NULL) AS has_lyrics
      FROM tracks t
      LEFT JOIN track_metadata m ON m.file_id = t.file_id
      LEFT JOIN track_analysis a ON a.file_id = t.file_id
      LEFT JOIN cover_art c ON c.file_id = t.file_id
      LEFT JOIN lyrics_assignments l ON l.file_id = t.file_id
      LEFT JOIN embedded_lyrics e ON e.file_id = t.file_id
      ${clause}
      ORDER BY t.file_id
      LIMIT ${limit}`;
  }
}

function toPlaylistDto(p: { id: string; rootId: string; name: string; trackFileIds: string[] }): PlaylistDto {
  return { id: encodeTrackKey(p.id), rootId: p.rootId, name: p.name, trackIds: p.trackFileIds.map(encodeTrackKey) };
}

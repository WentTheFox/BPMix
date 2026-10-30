import { Injectable } from '@nestjs/common';
import { encodeTrackKey, type ListTracksQuery, type Page, type PlaylistDto, type RootDto, type TrackDto } from '@bpmix/api';
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
             (l.lrc_file_id IS NOT NULL) AS has_lyrics
      FROM tracks t
      LEFT JOIN track_metadata m ON m.file_id = t.file_id
      LEFT JOIN track_analysis a ON a.file_id = t.file_id
      LEFT JOIN cover_art c ON c.file_id = t.file_id
      LEFT JOIN lyrics_assignments l ON l.file_id = t.file_id
      ${clause}
      ORDER BY t.file_id
      LIMIT ${limit}`;
  }
}

function toPlaylistDto(p: { id: string; rootId: string; name: string; trackFileIds: string[] }): PlaylistDto {
  return { id: encodeTrackKey(p.id), rootId: p.rootId, name: p.name, trackIds: p.trackFileIds.map(encodeTrackKey) };
}

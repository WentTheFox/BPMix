import { GoneException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { decodeTrackKey, encodeTrackKey, type SyncChangeDto, type SyncChangesResponseDto, type SyncSnapshotResponseDto } from '@bpmix/api';
import { DatabaseService } from '../db/database.module.js';
import { LibraryService } from '../library/library.service.js';
import { UserDataService } from '../userdata/userdata.service.js';

const RETENTION_MS = 90 * 24 * 60 * 60_000;
const FLOOR_SETTING = 'sync.floor';

/**
 * One kind of synced thing. `key` is the raw database key; a provider turns keys into the entity's
 * current state, and pages through everything that exists (for snapshots).
 */
interface EntityProvider {
  readonly entity: SyncChangeDto['entity'];
  /** Current state for each key (absent from the map = no longer exists), shaped as a change. */
  load(keys: string[], userId: string): Promise<Map<string, SyncChangeDto>>;
  /** The change telling a client this key is gone. */
  tombstone(key: string): SyncChangeDto;
  /** Everything that exists after `afterKey`, in key order. */
  page(afterKey: string | null, limit: number, userId: string): Promise<{ key: string; change: SyncChangeDto }[]>;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly providers: EntityProvider[];

  constructor(
    private readonly db: DatabaseService,
    private readonly library: LibraryService,
    private readonly userData: UserDataService,
  ) {
    this.providers = [
      this.trackProvider(),
      this.playlistProvider(),
      this.userPlaylistProvider(),
      this.playbackStateProvider(),
      this.settingProvider(),
    ];
  }

  private trackProvider(): EntityProvider {
    const library = this.library;
    return {
      entity: 'track',
      async load(keys) {
        const tracks = await library.getTracksByFileIds(keys);
        return new Map([...tracks].map(([fileId, track]) => [fileId, { entity: 'track' as const, id: track.id, track }]));
      },
      tombstone: (key) => ({ entity: 'track', id: encodeTrackKey(key), track: null }),
      async page(afterKey, limit) {
        const { items } = await library.listTracks({ cursor: afterKey ?? undefined, limit });
        return items.map((track) => ({ key: decodeTrackKey(track.id), change: { entity: 'track' as const, id: track.id, track } }));
      },
    };
  }

  private playlistProvider(): EntityProvider {
    const library = this.library;
    return {
      entity: 'playlist',
      async load(keys) {
        const playlists = await library.getPlaylistsByIds(keys);
        return new Map([...playlists].map(([id, playlist]) => [id, { entity: 'playlist' as const, id: playlist.id, playlist }]));
      },
      tombstone: (key) => ({ entity: 'playlist', id: encodeTrackKey(key), playlist: null }),
      async page(afterKey, limit) {
        const rows = await library.playlistsAfter(afterKey, limit);
        return rows.map(({ id, dto }) => ({ key: id, change: { entity: 'playlist' as const, id: dto.id, playlist: dto } }));
      },
    };
  }

  private userPlaylistProvider(): EntityProvider {
    const userData = this.userData;
    return {
      entity: 'userPlaylist',
      async load(keys, userId) {
        const playlists = await userData.getPlaylists(userId, keys);
        return new Map([...playlists].map(([id, userPlaylist]) => [id, { entity: 'userPlaylist' as const, id, userPlaylist }]));
      },
      tombstone: (key) => ({ entity: 'userPlaylist', id: key, userPlaylist: null }),
      async page(afterKey, limit, userId) {
        const rows = await userData.playlistsAfter(userId, afterKey, limit);
        return rows.map((userPlaylist) => ({ key: userPlaylist.id, change: { entity: 'userPlaylist' as const, id: userPlaylist.id, userPlaylist } }));
      },
    };
  }

  private playbackStateProvider(): EntityProvider {
    const userData = this.userData;
    return {
      entity: 'playbackState',
      async load(keys, userId) {
        const states = await userData.getPlaybackStates(userId, keys);
        return new Map([...states].map(([id, playbackState]) => [id, { entity: 'playbackState' as const, id, playbackState }]));
      },
      tombstone: (key) => ({ entity: 'playbackState', id: key, playbackState: null }),
      async page(afterKey, limit, userId) {
        const rows = await userData.playbackStatesAfter(userId, afterKey, limit);
        return rows.map((playbackState) => ({ key: playbackState.deviceId, change: { entity: 'playbackState' as const, id: playbackState.deviceId, playbackState } }));
      },
    };
  }

  private settingProvider(): EntityProvider {
    const userData = this.userData;
    return {
      entity: 'setting',
      async load(keys, userId) {
        const settings = await userData.getSettings(userId, keys);
        return new Map([...settings].map(([id, setting]) => [id, { entity: 'setting' as const, id, setting }]));
      },
      tombstone: (key) => ({ entity: 'setting', id: key, setting: null }),
      async page(afterKey, limit, userId) {
        const rows = await userData.settingsAfter(userId, afterKey, limit);
        return rows.map((setting) => ({ key: setting.key, change: { entity: 'setting' as const, id: setting.key, setting } }));
      },
    };
  }

  private async head(): Promise<bigint> {
    const [row] = await this.db.prisma.$queryRaw<{ head: bigint | null }[]>`SELECT MAX(rev) AS head FROM changes`;
    return row?.head ?? 0n;
  }

  private async floor(): Promise<bigint> {
    return BigInt((await this.db.libraryStore.getSetting(FLOOR_SETTING)) ?? '0');
  }

  /**
   * Everything that changed after `since`, each entity once, in the order it last changed, as its
   * current state. A cursor older than the retained history (or from a database that has since been
   * reset) can't be served: the client must take a snapshot instead.
   */
  async changesSince(since: bigint, limit: number, userId: string): Promise<SyncChangesResponseDto> {
    const [head, floor] = await Promise.all([this.head(), this.floor()]);
    if (since < floor || since > head) {
      throw new GoneException({ code: 'resync_required', message: 'Your sync position is too old to continue from; fetch a snapshot' });
    }
    // Upper-bounded by `head`, read first: revisions become visible in increasing order (see the
    // record_change trigger), so everything up to head is already here and the next call starts after it.
    const rows = await this.db.prisma.$queryRaw<{ entity: string; key: string; rev: bigint }[]>`
      SELECT entity, key, MAX(rev) AS rev FROM changes
      WHERE rev > ${since} AND rev <= ${head} AND (user_id IS NULL OR user_id = ${userId})
      GROUP BY entity, key
      ORDER BY MAX(rev)
      LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const byEntity = new Map<string, string[]>();
    for (const row of page) byEntity.set(row.entity, [...(byEntity.get(row.entity) ?? []), row.key]);
    const loaded = new Map<string, Map<string, SyncChangeDto>>();
    for (const provider of this.providers) {
      const keys = byEntity.get(provider.entity);
      if (keys) loaded.set(provider.entity, await provider.load(keys, userId));
    }

    const changes = page.map((row) => {
      const provider = this.providers.find((p) => p.entity === row.entity);
      if (!provider) throw new Error(`No sync provider for entity "${row.entity}"`);
      return loaded.get(row.entity)?.get(row.key) ?? provider.tombstone(row.key);
    });
    const cursor = hasMore ? page[page.length - 1]!.rev : head;
    return { changes, cursor: cursor.toString(), hasMore, roots: await this.library.listRoots() };
  }

  /**
   * Pages through everything that exists. The `after` token is (provider index, last key), so a
   * snapshot walks tracks first, then playlists, each in key order.
   */
  async snapshot(after: string | undefined, limit: number, userId: string): Promise<SyncSnapshotResponseDto> {
    const cursor = (await this.head()).toString();
    let [providerIndex, afterKey] = after ? decodeToken(after) : [0, null as string | null];
    const entities: SyncChangeDto[] = [];
    while (providerIndex < this.providers.length && entities.length < limit) {
      const provider = this.providers[providerIndex]!;
      const rows = await provider.page(afterKey, limit - entities.length, userId);
      for (const row of rows) entities.push(row.change);
      if (rows.length > 0) afterKey = rows[rows.length - 1]!.key;
      // A short page means this provider is exhausted; move on to the next from its start.
      if (rows.length < limit - (entities.length - rows.length)) {
        providerIndex++;
        afterKey = null;
      }
    }
    const next = providerIndex >= this.providers.length ? null : encodeToken(providerIndex, afterKey);
    return { entities, next, cursor, roots: await this.library.listRoots() };
  }

  /**
   * Trims history older than the retention window. A client whose cursor falls behind what's left
   * is told to resync, so history only has to cover "recently away", not "ever".
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async compact(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const [row] = await this.db.prisma.$queryRaw<{ max: bigint | null }[]>`SELECT MAX(rev) AS max FROM changes WHERE at < ${cutoff}`;
    if (row?.max == null) return 0;
    // Raise the floor first: a reader between the two steps then gets a clean 410, never a gap.
    await this.db.libraryStore.putSetting(FLOOR_SETTING, row.max.toString());
    const removed = await this.db.prisma.change.deleteMany({ where: { rev: { lte: row.max } } });
    this.logger.log(`Trimmed ${removed.count} sync change(s) older than 90 days`);
    return removed.count;
  }
}

function encodeToken(providerIndex: number, afterKey: string | null): string {
  return Buffer.from(JSON.stringify([providerIndex, afterKey])).toString('base64url');
}

function decodeToken(token: string): [number, string | null] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && Number.isInteger(parsed[0]) && (typeof parsed[1] === 'string' || parsed[1] === null)) return [parsed[0] as number, parsed[1] as string | null];
  } catch {
    // fall through
  }
  throw new GoneException({ code: 'resync_required', message: 'That snapshot position is not valid; start the snapshot again' });
}

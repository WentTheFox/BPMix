import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  decodeTrackKey,
  encodeTrackKey,
  MAX_PLAYBACK_STATE_BYTES,
  MAX_SETTING_VALUE_BYTES,
  type MutationDto,
  type MutationResultDto,
  type PlaybackStateDto,
  type UserPlaylistDto,
  type UserSettingDto,
} from '@bpmix/api';
import { DatabaseService } from '../db/database.module.js';
import type { Prisma } from '../generated/prisma/client.js';

const MAX_PLAYLISTS_PER_USER = 1000;
const MAX_SETTINGS_PER_USER = 500;
/** How long a finished operation id is remembered; a queue sitting offline longer than this could re-apply an op. */
const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60_000;

type Tx = Prisma.TransactionClient;

/** An operation that can never succeed (as opposed to a failure worth retrying): reported back so the client drops it. */
class Rejection extends Error {}

function fileIdsOf(trackKeys: string[]): string[] {
  try {
    return trackKeys.map(decodeTrackKey);
  } catch {
    throw new Rejection('Malformed track id');
  }
}

/** A list with repeats removed, keeping first occurrences in order. */
const unique = (ids: string[]) => [...new Set(ids)];

export const toUserPlaylistDto = (p: { id: string; name: string; trackFileIds: string[]; updatedAt: Date }): UserPlaylistDto => ({
  id: p.id,
  name: p.name,
  trackIds: p.trackFileIds.map(encodeTrackKey),
  updatedAtMs: p.updatedAt.getTime(),
});
export const toPlaybackStateDto = (r: { deviceId: string; state: unknown; updatedAt: Date }): PlaybackStateDto => ({
  deviceId: r.deviceId,
  state: r.state as Record<string, unknown>,
  updatedAtMs: r.updatedAt.getTime(),
});
export const toUserSettingDto = (r: { key: string; value: string; updatedAt: Date }): UserSettingDto => ({ key: r.key, value: r.value, updatedAtMs: r.updatedAt.getTime() });

/**
 * A user's own data - playlists they built, what each of their devices was playing, their settings -
 * and the queue of offline changes that edit it.
 */
@Injectable()
export class UserDataService {
  private readonly logger = new Logger(UserDataService.name);

  constructor(private readonly db: DatabaseService) {}

  private get prisma() {
    return this.db.prisma;
  }

  // ---------------------------------------------------------------- reads for the sync feed

  async getPlaylists(userId: string, ids: string[]): Promise<Map<string, UserPlaylistDto>> {
    const rows = await this.prisma.userPlaylist.findMany({ where: { ownerId: userId, id: { in: ids } } });
    return new Map(rows.map((r) => [r.id, toUserPlaylistDto(r)]));
  }

  async playlistsAfter(userId: string, afterId: string | null, limit: number): Promise<UserPlaylistDto[]> {
    const rows = await this.prisma.userPlaylist.findMany({
      where: { ownerId: userId, ...(afterId === null ? {} : { id: { gt: afterId } }) },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(toUserPlaylistDto);
  }

  async getPlaybackStates(userId: string, deviceIds: string[]): Promise<Map<string, PlaybackStateDto>> {
    const rows = await this.prisma.playbackStateRow.findMany({ where: { userId, deviceId: { in: deviceIds } } });
    return new Map(rows.map((r) => [r.deviceId, toPlaybackStateDto(r)]));
  }

  async playbackStatesAfter(userId: string, afterDeviceId: string | null, limit: number): Promise<PlaybackStateDto[]> {
    const rows = await this.prisma.playbackStateRow.findMany({
      where: { userId, ...(afterDeviceId === null ? {} : { deviceId: { gt: afterDeviceId } }) },
      orderBy: { deviceId: 'asc' },
      take: limit,
    });
    return rows.map(toPlaybackStateDto);
  }

  async getSettings(userId: string, keys: string[]): Promise<Map<string, UserSettingDto>> {
    const rows = await this.prisma.userSetting.findMany({ where: { userId, key: { in: keys } } });
    return new Map(rows.map((r) => [r.key, toUserSettingDto(r)]));
  }

  async settingsAfter(userId: string, afterKey: string | null, limit: number): Promise<UserSettingDto[]> {
    const rows = await this.prisma.userSetting.findMany({
      where: { userId, ...(afterKey === null ? {} : { key: { gt: afterKey } }) },
      orderBy: { key: 'asc' },
      take: limit,
    });
    return rows.map(toUserSettingDto);
  }

  // ---------------------------------------------------------------- the offline queue

  /** Applies each operation in order, on its own: one being rejected doesn't stop the rest. */
  async applyMutations(userId: string, mutations: MutationDto[]): Promise<MutationResultDto[]> {
    const results: MutationResultDto[] = [];
    for (const mutation of mutations) results.push(await this.applyOne(userId, mutation));
    return results;
  }

  private async applyOne(userId: string, mutation: MutationDto): Promise<MutationResultDto> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<MutationResultDto> => {
        // Recording the op id is part of the same transaction as its effect: either both happen or neither.
        const inserted = await tx.$executeRaw`INSERT INTO applied_mutations (op_id, user_id) VALUES (${mutation.opId}, ${userId}) ON CONFLICT (op_id) DO NOTHING`;
        if (inserted === 0) {
          const earlier = await tx.appliedMutation.findUnique({ where: { opId: mutation.opId } });
          if (earlier?.userId !== userId) throw new Rejection('Operation id already used');
          return { opId: mutation.opId, status: 'duplicate' };
        }
        await this.run(tx, userId, mutation);
        return { opId: mutation.opId, status: 'applied' };
      });
    } catch (err) {
      if (err instanceof Rejection) return { opId: mutation.opId, status: 'rejected', error: err.message };
      throw err; // a real failure: the whole request fails and the client retries the lot (ids make that safe)
    }
  }

  private async run(tx: Tx, userId: string, m: MutationDto): Promise<void> {
    switch (m.type) {
      case 'playlist.create': {
        const existing = await tx.userPlaylist.findUnique({ where: { id: m.id } });
        if (existing) {
          if (existing.ownerId !== userId) throw new Rejection('That playlist id is taken');
          return; // already created (an earlier attempt under another op id)
        }
        if ((await tx.userPlaylist.count({ where: { ownerId: userId } })) >= MAX_PLAYLISTS_PER_USER) throw new Rejection('Too many playlists');
        await tx.userPlaylist.create({ data: { id: m.id, ownerId: userId, name: m.name, trackFileIds: fileIdsOf(m.trackIds) } });
        return;
      }
      case 'playlist.rename': {
        const { count } = await tx.userPlaylist.updateMany({ where: { id: m.id, ownerId: userId }, data: { name: m.name } });
        if (count === 0) throw new Rejection('No such playlist');
        return;
      }
      case 'playlist.delete':
        // Deleting what's already gone is fine - the end state is what the user asked for.
        await tx.userPlaylist.deleteMany({ where: { id: m.id, ownerId: userId } });
        return;
      case 'playlist.addTracks': {
        const current = await this.lockPlaylist(tx, userId, m.id);
        const present = new Set(current);
        const additions = unique(fileIdsOf(m.trackIds)).filter((id) => !present.has(id));
        if (additions.length > 0) await tx.userPlaylist.update({ where: { id: m.id }, data: { trackFileIds: [...current, ...additions] } });
        return;
      }
      case 'playlist.removeTracks': {
        const current = await this.lockPlaylist(tx, userId, m.id);
        const removed = new Set(fileIdsOf(m.trackIds));
        const remaining = current.filter((id) => !removed.has(id));
        if (remaining.length !== current.length) await tx.userPlaylist.update({ where: { id: m.id }, data: { trackFileIds: remaining } });
        return;
      }
      case 'playlist.setTracks': {
        await this.lockPlaylist(tx, userId, m.id);
        await tx.userPlaylist.update({ where: { id: m.id }, data: { trackFileIds: fileIdsOf(m.trackIds) } });
        return;
      }
      case 'playbackState.set': {
        if (JSON.stringify(m.state).length > MAX_PLAYBACK_STATE_BYTES) throw new Rejection('Playback state too large');
        const state = m.state as Prisma.InputJsonValue;
        await tx.playbackStateRow.upsert({
          where: { userId_deviceId: { userId, deviceId: m.deviceId } },
          create: { userId, deviceId: m.deviceId, state },
          update: { state },
        });
        return;
      }
      case 'setting.set': {
        if (Buffer.byteLength(m.value) > MAX_SETTING_VALUE_BYTES) throw new Rejection('Setting value too large');
        const exists = await tx.userSetting.findUnique({ where: { userId_key: { userId, key: m.key } } });
        if (!exists && (await tx.userSetting.count({ where: { userId } })) >= MAX_SETTINGS_PER_USER) throw new Rejection('Too many settings');
        await tx.userSetting.upsert({ where: { userId_key: { userId, key: m.key } }, create: { userId, key: m.key, value: m.value }, update: { value: m.value } });
        return;
      }
      case 'setting.delete':
        await tx.userSetting.deleteMany({ where: { userId, key: m.key } });
        return;
    }
  }

  /** Locks the playlist row for the rest of the transaction and returns its tracks, so concurrent edits queue up instead of overwriting each other. */
  private async lockPlaylist(tx: Tx, userId: string, id: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ track_file_ids: string[] }[]>`SELECT track_file_ids FROM user_playlists WHERE id = ${id} AND owner_id = ${userId} FOR UPDATE`;
    if (!rows[0]) throw new Rejection('No such playlist');
    return rows[0].track_file_ids;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOldOperationIds(): Promise<void> {
    const { count } = await this.prisma.appliedMutation.deleteMany({ where: { appliedAt: { lt: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) } } });
    if (count > 0) this.logger.log(`Forgot ${count} old operation id(s)`);
  }
}

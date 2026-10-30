import type { PlaybackStateDto } from '@bpmix/api';
import type { LibraryStore, LoopMode, PlaybackState } from '../library-store/types';

const KEY = 'serverMode.devicePlayback';
/** Another device's state older than this is not offered as something to continue. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** What another device was playing, as this device offers to continue it. */
export interface RemotePlayback {
  deviceId: string;
  /** What that device calls itself ("Pixel 8"). */
  deviceName: string;
  updatedAtMs: number;
  playlistId: string;
  rootId: string | null;
  currentTrackFileId: string;
  positionSeconds: number;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
}

/** The part of this device's playback state that is worth sending (the rest is local screen state and volume). */
export function playbackPayload(state: PlaybackState, deviceName: string, now: number): Record<string, unknown> {
  return {
    deviceName,
    updatedAtMs: now,
    playlistId: state.playlistId,
    rootId: state.rootId,
    currentTrackFileId: state.currentTrackFileId,
    positionSeconds: state.positionSeconds,
    loopMode: state.loopMode,
    shuffleEnabled: state.shuffleEnabled,
  };
}

const isLoopMode = (value: unknown): value is LoopMode => value === 'off' || value === 'all' || value === 'one';

/** Reads one device's DTO back into something usable, or null if it isn't a playable state. */
export function toRemotePlayback(dto: PlaybackStateDto): RemotePlayback | null {
  const s = dto.state;
  if (typeof s.playlistId !== 'string' || typeof s.currentTrackFileId !== 'string') return null;
  return {
    deviceId: dto.deviceId,
    deviceName: typeof s.deviceName === 'string' && s.deviceName ? s.deviceName : 'Another device',
    updatedAtMs: typeof s.updatedAtMs === 'number' ? s.updatedAtMs : dto.updatedAtMs,
    playlistId: s.playlistId,
    rootId: typeof s.rootId === 'string' ? s.rootId : null,
    currentTrackFileId: s.currentTrackFileId,
    positionSeconds: typeof s.positionSeconds === 'number' && s.positionSeconds >= 0 ? s.positionSeconds : 0,
    loopMode: isLoopMode(s.loopMode) ? s.loopMode : 'off',
    shuffleEnabled: s.shuffleEnabled === true,
  };
}

/** The other devices' states as last synced, keyed by device id. */
async function readAll(store: LibraryStore): Promise<Record<string, PlaybackStateDto>> {
  try {
    const parsed: unknown = JSON.parse((await store.getSetting(KEY)) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PlaybackStateDto>) : {};
  } catch {
    return {};
  }
}

/** Records (or, with null, forgets) another device's state. This device's own is never kept: it already has it. */
export async function storeDevicePlayback(store: LibraryStore, ownDeviceId: string, change: { deviceId: string; dto: PlaybackStateDto | null }): Promise<void> {
  if (change.deviceId === ownDeviceId) return;
  const all = await readAll(store);
  if (change.dto) all[change.deviceId] = change.dto;
  else delete all[change.deviceId];
  await store.putSetting(KEY, JSON.stringify(all));
}

/** What could be continued here, most recently played first. */
export async function listDevicePlayback(store: LibraryStore, now: number): Promise<RemotePlayback[]> {
  const all = await readAll(store);
  return Object.values(all)
    .map(toRemotePlayback)
    .filter((remote): remote is RemotePlayback => remote !== null && now - remote.updatedAtMs < MAX_AGE_MS)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export const DEVICE_PLAYBACK_KEY = KEY;

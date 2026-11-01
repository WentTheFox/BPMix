import type { PlaybackStateDto } from '@beatseam/api';
import type { LibraryStore, LoopMode, PlaybackState } from '../library-store/types';

const KEY = 'serverMode.devicePlayback';
/** A shuffle order longer than this isn't sent: it would be most of the server's size limit for a state, and the other device can reshuffle. */
const MAX_SENT_SHUFFLE_ORDER = 1500;
/** A device's "playing" is believed this long after its last report (it reports at least every ~20s while playing). */
const PLAYING_FRESH_MS = 45_000;
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
  shuffleOrder: string[] | null;
  /** Was playing (not paused) when it last reported. See isPlayingNow for whether that can still be believed. */
  playing: boolean;
}

/** The part of this device's playback state that is worth sending (the rest is local screen state and volume). */
export function playbackPayload(state: PlaybackState, deviceName: string, now: number, playing: boolean): Record<string, unknown> {
  return {
    deviceName,
    updatedAtMs: now,
    playlistId: state.playlistId,
    rootId: state.rootId,
    currentTrackFileId: state.currentTrackFileId,
    positionSeconds: state.positionSeconds,
    loopMode: state.loopMode,
    shuffleEnabled: state.shuffleEnabled,
    shuffleOrder: state.shuffleEnabled && state.shuffleOrder && state.shuffleOrder.length <= MAX_SENT_SHUFFLE_ORDER ? state.shuffleOrder : null,
    playing,
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
    shuffleOrder: Array.isArray(s.shuffleOrder) && s.shuffleOrder.every((id) => typeof id === 'string') ? (s.shuffleOrder as string[]) : null,
    playing: s.playing === true,
  };
}

/** Whether that device can be taken to be playing right now: it said so, recently enough (a closed app can't say it stopped). */
export function isPlayingNow(remote: RemotePlayback, now: number): boolean {
  return remote.playing && now - remote.updatedAtMs < PLAYING_FRESH_MS;
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

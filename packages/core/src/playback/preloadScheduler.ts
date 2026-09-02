import type { DecodedAudio } from '../audio-engine/types';

export interface PreloadTickInfo {
  /** Seconds remaining in the currently playing track. */
  remainingSeconds: number;
  /** The next N tracks' fileIds, nearest first - the scheduler's lookahead window for this tick. */
  upcomingFileIds: string[];
}

export interface PreloadSchedulerOptions {
  /** Decodes a track by fileId - PlaylistPlayer wraps its resolveTrack()+engine.decodeFile() into this. */
  decode: (fileId: string) => Promise<DecodedAudio>;
  /**
   * Called once the nearest upcoming track's preload has exhausted every
   * retry threshold - Stage 6's "flag a playback error" case. Playback
   * itself is unaffected: playAt() just decodes cold (its existing,
   * already-correct fallback) when it gets there, since an empty preload
   * cache is a no-op, not a special case.
   */
  onGiveUp?: (fileId: string) => void;
  /** Seconds-remaining thresholds at which the nearest upcoming track is (re)attempted, in order. */
  retryThresholdsSeconds?: number[];
}

const DEFAULT_RETRY_THRESHOLDS_SECONDS = [60, 50, 40, 35];
/** How long to wait before retrying a failed deeper (non-nearest) slot - these aren't time-critical, so no need for the timed retry sequence. */
const DEEP_SLOT_RETRY_COOLDOWN_MS = 5000;

/**
 * Decides when to start decoding upcoming tracks ahead of when they're
 * needed, per Stage 6. The *nearest* upcoming track gets the plan's
 * explicit retry/backoff sequence (attempt once remainingSeconds crosses
 * each threshold in turn, e.g. 60s/50s/40s/35s remaining); once every
 * threshold is exhausted, onGiveUp fires and that track is left to load
 * cold when actually reached. Deeper lookahead slots (2nd, 3rd track
 * ahead) aren't time-critical, so they're just attempted eagerly as soon
 * as they enter the lookahead window and retried on a fixed cooldown on
 * failure, no threshold sequence needed.
 */
export class PreloadScheduler {
  private readonly decode: (fileId: string) => Promise<DecodedAudio>;
  private readonly onGiveUp?: (fileId: string) => void;
  private readonly retryThresholdsSeconds: number[];

  private ready = new Map<string, DecodedAudio>();
  private loadingFileIds = new Set<string>();
  private deepNextAttemptAtMs = new Map<string, number>();

  private lastNearestFileId: string | null = null;
  private nearestThresholdIndex = 0;
  private nearestGaveUpFor: string | null = null;

  constructor(options: PreloadSchedulerOptions) {
    this.decode = options.decode;
    this.onGiveUp = options.onGiveUp;
    this.retryThresholdsSeconds = options.retryThresholdsSeconds ?? DEFAULT_RETRY_THRESHOLDS_SECONDS;
  }

  tick(info: PreloadTickInfo): void {
    this.forgetStale(info.upcomingFileIds);
    const [nearestFileId, ...deeperFileIds] = info.upcomingFileIds;
    if (nearestFileId) {
      this.tickNearest(nearestFileId, info.remainingSeconds);
    }
    for (const fileId of deeperFileIds) {
      this.tickDeep(fileId);
    }
  }

  /** Returns (and removes) a ready preloaded buffer for fileId, if there is one. */
  takePreloaded(fileId: string): DecodedAudio | undefined {
    const decoded = this.ready.get(fileId);
    if (decoded) this.ready.delete(fileId);
    return decoded;
  }

  /** Drops any preloaded/in-progress state for tracks no longer in the current lookahead window, bounding memory to what's actually still relevant. */
  private forgetStale(upcomingFileIds: string[]): void {
    const keep = new Set(upcomingFileIds);
    for (const fileId of this.ready.keys()) {
      if (!keep.has(fileId)) this.ready.delete(fileId);
    }
    for (const fileId of this.deepNextAttemptAtMs.keys()) {
      if (!keep.has(fileId)) this.deepNextAttemptAtMs.delete(fileId);
    }
  }

  private tickNearest(fileId: string, remainingSeconds: number): void {
    // A different track has taken the nearest slot (natural advance, manual
    // skip, or a shuffle re-order) - that track's retry history doesn't
    // apply to this one.
    if (fileId !== this.lastNearestFileId) {
      this.lastNearestFileId = fileId;
      this.nearestThresholdIndex = 0;
      this.nearestGaveUpFor = null;
    }

    if (this.ready.has(fileId) || this.loadingFileIds.has(fileId)) return;
    if (this.nearestGaveUpFor === fileId) return;

    const threshold = this.retryThresholdsSeconds[this.nearestThresholdIndex];
    if (threshold === undefined || remainingSeconds > threshold) return;

    this.loadingFileIds.add(fileId);
    this.decode(fileId)
      .then((decoded) => {
        this.ready.set(fileId, decoded);
      })
      .catch(() => {
        this.nearestThresholdIndex++;
        if (this.nearestThresholdIndex >= this.retryThresholdsSeconds.length) {
          this.nearestGaveUpFor = fileId;
          this.onGiveUp?.(fileId);
        }
      })
      .finally(() => {
        this.loadingFileIds.delete(fileId);
      });
  }

  private tickDeep(fileId: string): void {
    if (this.ready.has(fileId) || this.loadingFileIds.has(fileId)) return;
    const nextAttemptAtMs = this.deepNextAttemptAtMs.get(fileId) ?? 0;
    if (Date.now() < nextAttemptAtMs) return;

    this.loadingFileIds.add(fileId);
    this.decode(fileId)
      .then((decoded) => {
        this.ready.set(fileId, decoded);
      })
      .catch(() => {
        this.deepNextAttemptAtMs.set(fileId, Date.now() + DEEP_SLOT_RETRY_COOLDOWN_MS);
      })
      .finally(() => {
        this.loadingFileIds.delete(fileId);
      });
  }
}

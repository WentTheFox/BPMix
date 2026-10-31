import { ApiError, NetworkError } from '@bpmix/api';
import type { LibraryStore } from '../library-store/types';
import { errorMessage } from '../errorMessage';
import type { ServerMode, ServerStatus } from '../server-mode/serverMode';
import type { OfflineBackend, OfflineFailure, OfflineRecord, OfflineState } from './types';

const INDEX_KEY = 'offline.index';
const BUDGET_KEY = 'offline.budgetBytes';
const CACHE_ON_PLAY_KEY = 'offline.cacheOnPlay';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_FAILURES = 50;

export interface OfflineLibraryDeps {
  backend: OfflineBackend;
  /** Holds the index and budget (as settings) and the metadata a download is verified against. */
  store: LibraryStore;
  server: Pick<ServerMode, 'getApi' | 'getStatus' | 'subscribe'>;
  now?: () => number;
  /** Simultaneous downloads. */
  concurrency?: number;
  maxAttempts?: number;
  /** Delay before attempt number `attempt` + 1 (attempt counts from 1). */
  retryDelayMs?: (attempt: number) => number;
}

class VerificationError extends Error {}

/**
 * Keeps chosen tracks on the device so they play with no connection: a download queue (a couple at a
 * time, with retries), checking each file against the hash the server gave, forgetting a copy once
 * the file changes on the server, and evicting the least recently played unpinned copies when over a
 * storage budget. Nothing here touches the network itself - the platform backend does the transfer.
 */
export class OfflineLibrary {
  /** Resolves once the saved index is read (local storage only). Reconciling it with what is actually on disk happens after, in the background. */
  readonly ready: Promise<void>;

  private records = new Map<string, OfflineRecord>();
  private queue: string[] = [];
  private readonly attempts = new Map<string, number>();
  private readonly active = new Map<string, AbortController>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly progress = new Map<string, number>();
  /** Whether each queued track was asked for to keep (pinned) or only to have at hand (evictable). */
  private readonly wantsPin = new Map<string, boolean>();
  private readonly listeners = new Set<(state: OfflineState) => void>();
  private failures: OfflineFailure[] = [];
  private budgetBytes = 0;
  private cacheOnPlay = false;
  /** Playback fetches in flight, so two readers of one track share a single transfer. */
  private readonly playFetches = new Map<string, Promise<boolean>>();
  private paused = false;
  private persistChain: Promise<void> = Promise.resolve();
  private state: OfflineState;
  private lastServerOffline = false;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(private readonly deps: OfflineLibraryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.concurrency = deps.concurrency ?? 2;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.retryDelayMs = deps.retryDelayMs ?? ((attempt) => 2000 * 4 ** (attempt - 1));
    this.state = this.computeState();
    this.ready = this.load();
    // A check-in that reached the server is the cue to pick downloads back up.
    deps.server.subscribe((status: ServerStatus) => {
      const recovered = this.lastServerOffline && !status.offline;
      this.lastServerOffline = status.offline;
      if (recovered || (this.paused && !status.offline && status.active && status.lastSyncedAtMs !== null)) this.resume();
    });
  }

  // ---------------------------------------------------------------- state

  getState(): OfflineState {
    return this.state;
  }

  subscribe(listener: (state: OfflineState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private computeState(): OfflineState {
    let downloadedBytes = 0;
    for (const record of this.records.values()) downloadedBytes += record.sizeBytes;
    return {
      downloadedCount: this.records.size,
      downloadedBytes,
      queuedCount: this.queue.length,
      activeCount: this.active.size,
      requestedCount: [...this.queue, ...this.active.keys()].filter((fileId) => this.wantsPin.get(fileId) === true).length,
      progress: Object.fromEntries(this.progress),
      budgetBytes: this.budgetBytes,
      cacheOnPlay: this.cacheOnPlay,
      paused: this.paused,
      failures: [...this.failures],
    };
  }

  private publish(): void {
    this.state = this.computeState();
    for (const listener of this.listeners) listener(this.state);
  }

  /** Whether a (possibly stale - see read) copy of this track is stored. Cheap enough to call per row. */
  isAvailable(fileId: string): boolean {
    return this.records.has(fileId);
  }

  isPinned(fileId: string): boolean {
    return this.records.get(fileId)?.pinned === true;
  }

  // ---------------------------------------------------------------- loading and saving

  private async load(): Promise<void> {
    const { store } = this.deps;
    const [rawIndex, rawBudget, rawCacheOnPlay] = await Promise.all([store.getSetting(INDEX_KEY), store.getSetting(BUDGET_KEY), store.getSetting(CACHE_ON_PLAY_KEY)]);
    if (rawIndex) {
      try {
        const parsed = JSON.parse(rawIndex) as OfflineRecord[];
        this.records = new Map(parsed.map((record) => [record.fileId, record]));
      } catch {
        this.records = new Map();
      }
    }
    this.budgetBytes = rawBudget ? Number(rawBudget) || 0 : 0;
    this.cacheOnPlay = rawCacheOnPlay === '1';
    this.publish();
    void this.reconcile();
  }

  /** Drops index entries whose file is gone, and files nothing in the index owns (left by an interrupted run). Background work. */
  private async reconcile(): Promise<void> {
    try {
      const onDisk = new Map((await this.deps.backend.list()).map((f) => [f.fileId, f.sizeBytes]));
      let changed = false;
      for (const fileId of [...this.records.keys()]) {
        if (!onDisk.has(fileId)) {
          this.records.delete(fileId);
          changed = true;
        }
      }
      for (const fileId of onDisk.keys()) {
        if (!this.records.has(fileId) && !this.active.has(fileId)) await this.deps.backend.remove(fileId).catch(() => undefined);
      }
      if (changed) await this.persist();
      this.publish();
    } catch {
      // Storage we can't list is storage we can't reconcile; the index stays as it was.
    }
  }

  /** Serialised, so overlapping saves can't interleave and leave an older index last. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.records.values()]);
    this.persistChain = this.persistChain.then(() => this.deps.store.putSetting(INDEX_KEY, snapshot)).catch(() => undefined);
    return this.persistChain;
  }

  // ---------------------------------------------------------------- reading

  /**
   * The stored bytes, or null if none can be trusted: not downloaded, the file is gone from disk, or the
   * server has since replaced the file (its hash no longer matches what was downloaded), in which case the
   * stale copy is dropped (and fetched again, if it was one the person asked to keep).
   */
  async read(fileId: string): Promise<ArrayBuffer | null> {
    await this.ready;
    const record = this.records.get(fileId);
    if (!record) return null;
    const current = (await this.deps.store.getMetadata(fileId))?.contentHash;
    if (current && SHA256_HEX.test(current) && current !== record.sha256) {
      await this.forget([fileId]);
      if (record.pinned) this.request([fileId], { pin: true });
      return null;
    }
    const bytes = await this.deps.backend.read(fileId);
    if (!bytes) {
      this.records.delete(fileId);
      void this.persist();
      this.publish();
      return null;
    }
    record.lastUsedAtMs = this.now();
    return bytes;
  }

  // ---------------------------------------------------------------- choosing what to keep

  /** Makes these tracks available offline: queues whichever aren't stored (and fresh) yet. */
  request(fileIds: string[], options: { pin?: boolean } = {}): void {
    const pin = options.pin ?? true;
    void this.ready.then(() => {
      for (const fileId of fileIds) {
        const record = this.records.get(fileId);
        if (record) {
          if (pin && !record.pinned) record.pinned = true;
          continue;
        }
        this.failures = this.failures.filter((f) => f.fileId !== fileId);
        this.attempts.delete(fileId);
        this.wantsPin.set(fileId, pin || this.wantsPin.get(fileId) === true);
        if (!this.queue.includes(fileId) && !this.active.has(fileId)) this.queue.push(fileId);
      }
      void this.persist();
      this.publish();
      this.pump();
    });
  }

  /** Stops keeping these (and cancels any in flight), freeing their space. */
  async remove(fileIds: string[]): Promise<void> {
    await this.ready;
    this.cancel(fileIds);
    await this.forget(fileIds);
  }

  /** Forgets everything downloaded and cancels everything queued. */
  async clear(): Promise<void> {
    await this.ready;
    this.cancelAll();
    await this.forget([...this.records.keys()]);
  }

  private async forget(fileIds: string[]): Promise<void> {
    for (const fileId of fileIds) {
      this.records.delete(fileId);
      await this.deps.backend.remove(fileId).catch(() => undefined);
    }
    await this.persist();
    this.publish();
  }

  /** Takes tracks out of the queue and aborts any transfer in flight. Already-downloaded copies stay. */
  cancel(fileIds: string[]): void {
    const cancelled = new Set(fileIds);
    this.queue = this.queue.filter((id) => !cancelled.has(id));
    for (const fileId of fileIds) this.wantsPin.delete(fileId);
    for (const fileId of fileIds) this.active.get(fileId)?.abort();
    this.publish();
  }

  cancelAll(): void {
    this.queue = [];
    for (const controller of this.active.values()) controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.publish();
  }

  /** Limit on what unpinned downloads may occupy. 0 means no limit. */
  async setBudgetBytes(bytes: number): Promise<void> {
    await this.ready;
    this.budgetBytes = Math.max(0, Math.round(bytes));
    await this.deps.store.putSetting(BUDGET_KEY, String(this.budgetBytes));
    await this.evict();
    this.publish();
  }

  /** Whether tracks played from the server are kept (unpinned, so the budget can evict them). */
  async setCacheOnPlay(on: boolean): Promise<void> {
    await this.ready;
    this.cacheOnPlay = on;
    await this.deps.store.putSetting(CACHE_ON_PLAY_KEY, on ? '1' : '0');
    this.publish();
  }

  /**
   * For playback with cache-on-play: fetches the track into storage (unpinned) so one transfer both plays
   * it and keeps it, instead of streaming it now and downloading it again. Resolves true when a copy is
   * stored; any failure leaves no trace (no retry, no pause) and the caller streams it as it would have.
   */
  fetchForPlayback(fileId: string): Promise<boolean> {
    const running = this.playFetches.get(fileId);
    if (running) return running;
    const run = (async () => {
      await this.ready;
      if (!this.cacheOnPlay) return false;
      if (this.records.has(fileId)) return true;
      // Already being fetched on purpose (queued or active as a download): leave that alone.
      if (this.queue.includes(fileId) || this.active.has(fileId)) return false;
      const controller = new AbortController();
      this.active.set(fileId, controller);
      this.progress.set(fileId, 0);
      this.wantsPin.set(fileId, false);
      this.publish();
      try {
        await this.download(fileId, controller.signal);
        return true;
      } catch {
        this.wantsPin.delete(fileId);
        return false;
      } finally {
        this.active.delete(fileId);
        this.progress.delete(fileId);
        this.publish();
        this.pump();
      }
    })().finally(() => this.playFetches.delete(fileId));
    this.playFetches.set(fileId, run);
    return run;
  }

  /** Removes the least recently played unpinned copies until the total fits the budget. Pinned copies are never evicted. */
  private async evict(protect: ReadonlySet<string> = new Set()): Promise<void> {
    if (this.budgetBytes <= 0) return;
    let total = 0;
    for (const record of this.records.values()) total += record.sizeBytes;
    if (total <= this.budgetBytes) return;
    const candidates = [...this.records.values()].filter((r) => !r.pinned && !protect.has(r.fileId)).sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
    const evicted: string[] = [];
    for (const record of candidates) {
      if (total <= this.budgetBytes) break;
      total -= record.sizeBytes;
      evicted.push(record.fileId);
    }
    if (evicted.length > 0) await this.forget(evicted);
  }

  // ---------------------------------------------------------------- the queue

  pause(): void {
    this.paused = true;
    this.publish();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.publish();
    this.pump();
  }

  private pump(): void {
    while (!this.paused && this.active.size < this.concurrency && this.queue.length > 0) {
      const fileId = this.queue.shift()!;
      void this.run(fileId);
    }
  }

  private async run(fileId: string): Promise<void> {
    const controller = new AbortController();
    this.active.set(fileId, controller);
    this.progress.set(fileId, 0);
    this.publish();
    try {
      await this.download(fileId, controller.signal);
      this.attempts.delete(fileId);
    } catch (err) {
      this.handleFailure(fileId, err, controller.signal.aborted);
    } finally {
      this.active.delete(fileId);
      this.progress.delete(fileId);
      this.publish();
      this.pump();
    }
  }

  private async download(fileId: string, signal: AbortSignal): Promise<void> {
    const api = this.deps.server.getApi();
    if (!api) throw new NetworkError(new Error('Not signed in to a server'));
    const expected = (await this.deps.store.getMetadata(fileId))?.contentHash;
    const headers = await api.authHeaders();
    const result = await this.deps.backend.download({
      fileId,
      url: api.url(api.streamPathForFileId(fileId)),
      headers,
      signal,
      onProgress: (bytes) => {
        this.progress.set(fileId, bytes);
        this.publish();
      },
    });
    if (expected && SHA256_HEX.test(expected) && expected !== result.sha256) {
      await this.deps.backend.remove(fileId).catch(() => undefined);
      throw new VerificationError('The downloaded file does not match what the server has');
    }
    const at = this.now();
    this.records.set(fileId, { fileId, sizeBytes: result.sizeBytes, sha256: result.sha256, downloadedAtMs: at, lastUsedAtMs: at, pinned: this.wantsPin.get(fileId) ?? true });
    this.wantsPin.delete(fileId);
    await this.persist();
    await this.evict(new Set([fileId]));
  }

  private handleFailure(fileId: string, err: unknown, cancelled: boolean): void {
    if (cancelled) return;
    if (err instanceof NetworkError) {
      // Not this track's fault: keep its place, stop trying until the server can be reached again.
      this.queue.unshift(fileId);
      this.paused = true;
      return;
    }
    if (err instanceof ApiError && err.status === 401) {
      this.queue.unshift(fileId);
      this.paused = true;
      this.addFailure(fileId, 'Signed out by the server');
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      this.addFailure(fileId, 'No longer on the server');
      return;
    }
    const attempt = (this.attempts.get(fileId) ?? 0) + 1;
    this.attempts.set(fileId, attempt);
    if (attempt >= this.maxAttempts) {
      this.addFailure(fileId, errorMessage(err));
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.queue.push(fileId);
      this.publish();
      this.pump();
    }, this.retryDelayMs(attempt));
    this.timers.add(timer);
  }

  private addFailure(fileId: string, message: string): void {
    this.failures = [...this.failures.filter((f) => f.fileId !== fileId), { fileId, message }].slice(-MAX_FAILURES);
  }
}

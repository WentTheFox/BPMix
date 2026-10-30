import { ApiError, NetworkError, type ApiClient, type MutationDto } from '@bpmix/api';
import type { LibraryStore } from '../library-store/types';
import { randomId } from './randomId';

const QUEUE_KEY = 'serverMode.mutationQueue';
const BATCH_SIZE = 50;
const MAX_REJECTIONS = 20;

/** An operation, before it has been given its id. */
export type NewMutation = MutationDto extends infer M ? (M extends { opId: string } ? Omit<M, 'opId'> : never) : never;

export interface MutationQueueState {
  /** Changes made here that the server hasn't acknowledged yet. */
  pending: number;
  flushing: boolean;
  /** Operations the server refused for good (not yours, too large, ...), newest last. */
  rejected: { opId: string; error: string }[];
}

/**
 * Changes made on this device, kept until the server has them: written down first, sent later (right
 * away if the server can be reached, otherwise at the next check-in). Each carries its own id, so
 * sending a batch again after a dropped connection can't apply anything twice.
 */
export class MutationQueue {
  readonly ready: Promise<void>;
  private queue: MutationDto[] = [];
  private flushing: Promise<void> | null = null;
  private rejected: MutationQueueState['rejected'] = [];
  private state: MutationQueueState = { pending: 0, flushing: false, rejected: [] };
  private readonly listeners = new Set<(state: MutationQueueState) => void>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: LibraryStore,
    private readonly getApi: () => ApiClient | null,
  ) {
    this.ready = this.load();
  }

  getState(): MutationQueueState {
    return this.state;
  }

  subscribe(listener: (state: MutationQueueState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    this.state = { pending: this.queue.length, flushing: this.flushing !== null, rejected: [...this.rejected] };
    for (const listener of this.listeners) listener(this.state);
  }

  private async load(): Promise<void> {
    const raw = await this.store.getSetting(QUEUE_KEY);
    if (raw) {
      try {
        this.queue = JSON.parse(raw) as MutationDto[];
      } catch {
        this.queue = [];
      }
    }
    this.publish();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.queue);
    this.persistChain = this.persistChain.then(() => this.store.putSetting(QUEUE_KEY, snapshot)).catch(() => undefined);
    return this.persistChain;
  }

  /** Writes the change down, then tries to send it without making the caller wait. */
  async enqueue(mutation: NewMutation): Promise<void> {
    await this.ready;
    // A newer value for a setting makes any waiting older one pointless (last write wins anyway).
    if (mutation.type === 'setting.set' || mutation.type === 'setting.delete') {
      this.queue = this.queue.filter((m) => !((m.type === 'setting.set' || m.type === 'setting.delete') && m.key === mutation.key));
    }
    // Likewise only the newest playback state of a device matters.
    if (mutation.type === 'playbackState.set') {
      this.queue = this.queue.filter((m) => !(m.type === 'playbackState.set' && m.deviceId === mutation.deviceId));
    }
    this.queue.push({ ...mutation, opId: randomId() } as MutationDto);
    await this.persist();
    this.publish();
    void this.flush();
  }

  /** Sends everything waiting, oldest first, in batches. Never rejects: what could not be sent stays queued. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.drain().finally(() => {
      this.flushing = null;
      this.publish();
    });
    this.flushing = run;
    this.publish();
    return run;
  }

  private async drain(): Promise<void> {
    await this.ready;
    const api = this.getApi();
    while (api && this.queue.length > 0) {
      const batch = this.queue.slice(0, BATCH_SIZE);
      let results;
      try {
        results = (await api.mutations(batch)).results;
      } catch (err) {
        // Offline, signed out, or the server is unwell: keep everything and try again at the next check-in.
        if (err instanceof NetworkError || err instanceof ApiError) return;
        throw err;
      }
      const done = new Set(results.map((r) => r.opId));
      for (const result of results) {
        if (result.status === 'rejected') this.rejected = [...this.rejected, { opId: result.opId, error: result.error ?? 'Rejected' }].slice(-MAX_REJECTIONS);
      }
      // Anything the server answered for is finished with (applied, already applied, or refused for good).
      this.queue = this.queue.filter((m) => !done.has(m.opId));
      await this.persist();
      this.publish();
      if (results.length === 0) return; // a server that answers nothing would loop forever
    }
  }

  /** Forgets everything waiting (signing out: those changes belonged to that account). */
  async clear(): Promise<void> {
    await this.ready;
    this.queue = [];
    this.rejected = [];
    await this.persist();
    this.publish();
  }
}

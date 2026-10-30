import { EventEmitter } from 'node:events';
import pg from 'pg';
import { JOB_CHANNEL } from './jobQueue.js';

const RECONNECT_MS = 5_000;

/**
 * LISTENs on the job channel over its own connection and emits 'wake' when any
 * process queues work or finishes a job. That replaces polling the table: idle
 * workers sleep until told (or until a known backoff/lease time arrives).
 */
export class JobNotifier extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', () => this.emit('wake'));
    // A dropped connection loses notifications, so wake everyone on reconnect to catch up.
    const onLost = (err?: unknown) => {
      if (this.client !== client) return;
      this.client = null;
      if (err) this.onError(err);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => void this.connect().catch(this.onError), RECONNECT_MS);
    };
    client.on('error', onLost);
    client.on('end', () => onLost());
    await client.connect();
    await client.query(`LISTEN ${JOB_CHANNEL}`);
    this.client = client;
    this.emit('wake');
  }
}

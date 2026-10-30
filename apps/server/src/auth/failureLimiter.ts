/**
 * Counts failed sign-in attempts per key (an account, an address) inside a window, in memory. The route
 * throttle counts address+username *pairs*, so one address trying many usernames, or many addresses trying
 * one username, each get a fresh budget every time; these totals close both. A server restart resets the
 * counts, which only ever helps an attacker by one window's worth of attempts.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  isBlocked(key: string, max: number): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.resetAt > this.now() && entry.count >= max;
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) entry.count += 1;
    else {
      if (this.entries.size > 10_000) this.purge(now);
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    }
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private purge(now: number): void {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
  }
}

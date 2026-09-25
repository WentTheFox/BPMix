import { describe, expect, it, vi } from 'vitest';
import { getTasks, runLatestTask, runTask, type TaskContext } from './taskQueue';

/** A promise plus its resolver, for holding a task body open until the test says so. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const stateOf = (id: string) => getTasks().find((t) => t.id === id)?.state;

describe('taskQueue', () => {
  it('runs foreground tasks one at a time, in request order', async () => {
    const order: string[] = [];
    const firstGate = gate();
    const first = runTask({ id: 'a', label: 'A', priority: 'foreground' }, async () => {
      order.push('a:start');
      await firstGate.promise;
      order.push('a:end');
    });
    const second = runTask({ id: 'b', label: 'B', priority: 'foreground' }, async () => {
      order.push('b:start');
    });

    await vi.waitFor(() => expect(stateOf('a')).toBe('running'));
    expect(stateOf('b')).toBe('queued');
    firstGate.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(getTasks()).toEqual([]);
  });

  it('pauses a background task at its next checkpoint while foreground work runs, then resumes it', async () => {
    const order: string[] = [];
    let context!: TaskContext;
    const reachedFirstItem = gate();
    const continueBackground = gate();
    const background = runTask({ id: 'meta', label: 'Metadata', priority: 'background' }, async (ctx) => {
      context = ctx;
      order.push('meta:item1');
      reachedFirstItem.open();
      await continueBackground.promise;
      await ctx.checkpoint();
      order.push('meta:item2');
    });
    await reachedFirstItem.promise;

    const foreground = runTask({ id: 'scan', label: 'Scan', priority: 'foreground' }, async () => {
      order.push('scan');
    });
    expect(stateOf('scan')).toBe('queued'); // doesn't preempt mid-item
    continueBackground.open();

    await foreground;
    await background;
    expect(order).toEqual(['meta:item1', 'scan', 'meta:item2']);
    expect(context).toBeDefined();
  });

  it('reports a yielded background task as paused', async () => {
    const holdForeground = gate();
    const backgroundStarted = gate();
    let resumeCheck!: Promise<void>;
    const background = runTask({ id: 'bg', label: 'BG', priority: 'background' }, async (ctx) => {
      backgroundStarted.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      resumeCheck = ctx.checkpoint();
      await resumeCheck;
    });
    await backgroundStarted.promise;
    const foreground = runTask({ id: 'fg', label: 'FG', priority: 'foreground' }, () => holdForeground.promise);

    await vi.waitFor(() => expect(stateOf('fg')).toBe('running'));
    expect(stateOf('bg')).toBe('paused');
    holdForeground.open();
    await Promise.all([foreground, background]);
  });

  it('starts waiting foreground work before an earlier-queued background task', async () => {
    const order: string[] = [];
    const holder = gate();
    const running = runTask({ id: 'first', label: 'First', priority: 'foreground' }, () => holder.promise);
    const background = runTask({ id: 'bg', label: 'BG', priority: 'background' }, async () => void order.push('bg'));
    const foreground = runTask({ id: 'fg', label: 'FG', priority: 'foreground' }, async () => void order.push('fg'));

    holder.open();
    await Promise.all([running, background, foreground]);
    expect(order).toEqual(['fg', 'bg']);
  });

  it('pulls a task out of the queue as soon as its signal aborts, running its body once so it can throw', async () => {
    const holder = gate();
    const running = runTask({ id: 'first', label: 'First', priority: 'foreground' }, () => holder.promise);
    const controller = new AbortController();
    const queued = runTask({ id: 'queued', label: 'Queued', priority: 'foreground', signal: controller.signal }, async () => {
      if (controller.signal.aborted) throw new Error('cancelled');
      return 'ran';
    });
    expect(stateOf('queued')).toBe('queued');

    controller.abort();
    await expect(queued).rejects.toThrow('cancelled');
    expect(stateOf('queued')).toBeUndefined();

    holder.open();
    await running;
  });

  it('exposes reported progress on the task (throttled)', async () => {
    const holder = gate();
    const task = runTask({ id: 'p', label: 'P', priority: 'foreground' }, async (ctx) => {
      ctx.reportProgress({ detail: 'working', current: 3, total: 10 });
      await holder.promise;
    });
    await vi.waitFor(() => expect(getTasks().find((t) => t.id === 'p')?.progress).toEqual({ detail: 'working', current: 3, total: 10 }));
    holder.open();
    await task;
  });

  it('runLatestTask: a newer request drops an older one still waiting in the queue, but not one already running', async () => {
    const ran: string[] = [];
    const holder = gate();
    const blocker = runTask({ id: 'blocker', label: 'Blocker', priority: 'foreground' }, () => holder.promise);
    const runningGate = gate();
    // Starts only once the blocker is done, so first queue two same-id requests behind it.
    const older = runLatestTask({ id: 'meta', label: 'Meta', priority: 'background' }, async () => void ran.push('older'));
    const newer = runLatestTask({ id: 'meta', label: 'Meta', priority: 'background' }, async () => {
      ran.push('newer');
      await runningGate.promise;
    });
    expect(getTasks().filter((t) => t.id === 'meta')).toHaveLength(1); // the older one left the queue right away
    await older; // resolved without running

    holder.open();
    await blocker;
    await vi.waitFor(() => expect(ran).toEqual(['newer']));
    // A request arriving while 'newer' runs doesn't stop it - it just queues.
    const newest = runLatestTask({ id: 'meta', label: 'Meta', priority: 'background' }, async () => void ran.push('newest'));
    runningGate.open();
    await Promise.all([newer, newest]);
    expect(ran).toEqual(['newer', 'newest']);
  });
});

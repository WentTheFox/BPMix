import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '../../tasks/taskQueue';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { runNotificationAction, clearNotificationActions } from './notificationActions';
import { addError, clearAllNotifications, dismissNotification, upsertNotification } from './notificationsThunks';
import { DONE_AUTO_DISMISS_MS, syncTaskNotifications } from './syncTaskNotifications';
import type { TaskSource } from './syncTaskNotifications';

let clock = 1000;
function makeStore() {
  return createStore({ now: () => clock } as unknown as Services);
}
const items = (store: ReturnType<typeof makeStore>) => store.getState().notifications.items;

beforeEach(() => {
  clock = 1000;
  clearNotificationActions();
});

describe('notifications', () => {
  it('adds errors newest first', () => {
    const store = makeStore();
    store.dispatch(addError('first', 'boom'));
    clock = 2000;
    store.dispatch(addError('second'));
    expect(items(store).map((n) => n.title)).toEqual(['second', 'first']);
    expect(items(store)[1]).toMatchObject({ kind: 'error', detail: 'boom', createdAt: 1000 });
    expect(items(store)[0]!.id).not.toBe(items(store)[1]!.id);
  });

  it('upserts progress by id in place, keeping the original createdAt', () => {
    const store = makeStore();
    store.dispatch(upsertNotification({ id: 'scan', title: 'Scanning', progress: { current: 1, total: 10, done: false } }));
    clock = 5000;
    store.dispatch(upsertNotification({ id: 'scan', title: 'Scanning', progress: { current: 5, total: 10, done: false } }));
    expect(items(store)).toHaveLength(1);
    expect(items(store)[0]).toMatchObject({ kind: 'progress', createdAt: 1000, progress: { current: 5 } });
  });

  it('keeps action callbacks out of state but runs them by id, and drops them on replace/dismiss', () => {
    const store = makeStore();
    const cancel = vi.fn();
    store.dispatch(upsertNotification({ id: 'scan', title: 'Scanning', action: { label: 'Cancel', onPress: cancel } }));
    expect(items(store)[0]!.actionLabel).toBe('Cancel');
    expect(JSON.stringify(store.getState())).not.toContain('onPress');
    runNotificationAction('scan');
    expect(cancel).toHaveBeenCalledTimes(1);

    store.dispatch(upsertNotification({ id: 'scan', title: 'Scanning' }));
    expect(items(store)[0]!.actionLabel).toBeUndefined();
    runNotificationAction('scan');
    expect(cancel).toHaveBeenCalledTimes(1);

    store.dispatch(upsertNotification({ id: 'x', title: 'x', action: { label: 'Cancel', onPress: cancel } }));
    store.dispatch(dismissNotification('x'));
    runNotificationAction('x');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(items(store).map((n) => n.id)).toEqual(['scan']);
  });

  it('clears everything', () => {
    const store = makeStore();
    store.dispatch(addError('e'));
    store.dispatch(upsertNotification({ id: 'p', title: 'p' }));
    store.dispatch(clearAllNotifications());
    expect(items(store)).toEqual([]);
  });
});

describe('syncTaskNotifications', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeSource() {
    let tasks: TaskInfo[] = [];
    const listeners = new Set<() => void>();
    const source: TaskSource = {
      getTasks: () => tasks,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    return {
      source,
      set(next: TaskInfo[]) {
        tasks = next;
        listeners.forEach((l) => l());
      },
    };
  }
  const task = (over: Partial<TaskInfo>): TaskInfo => ({ id: 't', label: 'Scan', priority: 'background', state: 'running', ...over });

  it('mirrors task state, with detail in the title and a Cancel action', () => {
    const store = makeStore();
    const { source, set } = makeSource();
    const cancel = vi.fn();
    syncTaskNotifications(store.dispatch, source);
    set([task({ progress: { detail: '5 files', current: 5, total: 10 }, cancel })]);
    expect(items(store)[0]).toMatchObject({ title: 'Scan - 5 files', progress: { current: 5, total: 10, done: false }, actionLabel: 'Cancel' });
    runNotificationAction('t');
    expect(cancel).toHaveBeenCalled();
  });

  it('shows the most active of several same-id tasks', () => {
    const store = makeStore();
    const { source, set } = makeSource();
    syncTaskNotifications(store.dispatch, source);
    set([task({ state: 'queued' }), task({ state: 'running', progress: { detail: '', current: 3, total: 9 } })]);
    expect(items(store)).toHaveLength(1);
    expect(items(store)[0]!.status).toBeUndefined();
    expect(items(store)[0]!.progress?.current).toBe(3);
  });

  it('marks a finished task with a known total done, then auto-dismisses it', () => {
    const store = makeStore();
    const { source, set } = makeSource();
    syncTaskNotifications(store.dispatch, source);
    set([task({ progress: { detail: '', current: 4, total: 10 } })]);
    set([]);
    expect(items(store)[0]!.progress).toEqual({ current: 10, total: 10, done: true });
    vi.advanceTimersByTime(DONE_AUTO_DISMISS_MS);
    expect(items(store)).toEqual([]);
  });

  it('dismisses a finished task with no known total immediately', () => {
    const store = makeStore();
    const { source, set } = makeSource();
    syncTaskNotifications(store.dispatch, source);
    set([task({})]);
    set([]);
    expect(items(store)).toEqual([]);
  });

  it('cancels the pending auto-dismiss when the same id restarts', () => {
    const store = makeStore();
    const { source, set } = makeSource();
    syncTaskNotifications(store.dispatch, source);
    set([task({ progress: { detail: '', current: 1, total: 2 } })]);
    set([]);
    set([task({ progress: { detail: '', current: 0, total: 5 } })]);
    vi.advanceTimersByTime(DONE_AUTO_DISMISS_MS);
    expect(items(store)).toHaveLength(1);
    expect(items(store)[0]!.progress?.done).toBe(false);
  });

  it('stops listening and clears timers when unsubscribed', () => {
    const store = makeStore();
    const { source, set } = makeSource();
    const stop = syncTaskNotifications(store.dispatch, source);
    stop();
    set([task({})]);
    expect(items(store)).toEqual([]);
  });
});

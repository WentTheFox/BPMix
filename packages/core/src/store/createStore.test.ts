import { describe, expect, it } from 'vitest';
import { createStore } from './createStore';
import type { Services } from './services';

describe('createStore', () => {
  it('builds a store whose thunks receive the injected services', async () => {
    const services = { now: () => 42 } as unknown as Services;
    const store = createStore(services);

    const seen = await store.dispatch((_dispatch, _getState, extra) => extra.now());

    expect(seen).toBe(42);
    expect(store.getState()).toEqual({});
  });
});

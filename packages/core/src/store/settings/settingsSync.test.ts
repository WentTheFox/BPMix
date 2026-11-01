import type { MutationDto } from '@beatseam/api';
import { describe, expect, it } from 'vitest';
import { ServerMode } from '../../server-mode/serverMode';
import { fakeServer, json, MemoryStore } from '../../server-mode/testing';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import { settingsUpdated } from './settingsSlice';
import { CROSSFADE_SECONDS_SETTING_KEY, THEME_MODE_SETTING_KEY } from './settingsStorage';

const ROOT = { id: 'Music', displayName: 'Music', kind: 'library' as const };
const setting = (key: string, value: string) => ({ entity: 'setting' as const, id: key, setting: { key, value, updatedAtMs: 1 } });

async function signedIn() {
  const store = new MemoryStore();
  store.settings.set('serverMode.config', JSON.stringify({ url: 'https://s.example', token: 'bpd_tok', userName: 'Sam' }));
  store.settings.set('serverMode.cursor', '1');
  store.settings.set('serverMode.roots', JSON.stringify([ROOT]));
  const server = fakeServer();
  const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
  await mode.ready;
  return { store, server, mode };
}

describe('settings coming from the server', () => {
  it('applies the account-wide preferences', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ changes: [setting(CROSSFADE_SECONDS_SETTING_KEY, '9'), setting(THEME_MODE_SETTING_KEY, 'amoled')], cursor: '2', hasMore: false, roots: [ROOT], totals: { tracks: 0, playlists: 0 } });
    expect(await mode.sync()).toEqual({ kind: 'delta', changed: true });
    expect(store.settings.get(CROSSFADE_SECONDS_SETTING_KEY)).toBe('9');
    expect(store.settings.get(THEME_MODE_SETTING_KEY)).toBe('amoled');
  });

  it('ignores everything else, so a server cannot write local credentials or its own sign-in', async () => {
    const { store, server, mode } = await signedIn();
    const before = store.settings.get('serverMode.config');
    server.handler = () =>
      json({
        changes: [setting('serverMode.config', '{"url":"https://evil.example","token":"x"}'), setting('settings.lastFmSessionKey', 'stolen'), setting('serverMode.mutationQueue', '[]')],
        cursor: '2',
        hasMore: false,
        roots: [ROOT],
        totals: { tracks: 0, playlists: 0 },
      });
    expect(await mode.sync()).toEqual({ kind: 'delta', changed: false });
    expect(store.settings.get('serverMode.config')).toBe(before);
    expect(store.settings.has('settings.lastFmSessionKey')).toBe(false);
    expect(store.settings.has('serverMode.mutationQueue')).toBe(false);
  });
});

describe('settings going to the server', () => {
  async function setup() {
    const { store, server, mode } = await signedIn();
    const sent: MutationDto[] = [];
    server.handler = (_path, init) => {
      const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
      sent.push(...batch);
      return json({ results: batch.map((m) => ({ opId: m.opId, status: 'applied' })) });
    };
    const services = { libraryStore: store, playlistPlayer: { setCrossfadeSeconds: () => {}, getShuffleOrder: () => null }, livePlayback: fakeLivePlayback().live, serverMode: mode, now: () => 1 } as unknown as Services;
    const app = createStore(services);
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return { store, mode, sent, app, settle };
  }

  it('sends a changed preference, and leaves device-only settings alone', async () => {
    const { sent, app, settle, store } = await setup();
    app.dispatch(settingsUpdated({ crossfadeSeconds: 7, lastFmApiKey: 'key', discordRichPresenceEnabled: true }));
    await settle();
    expect(sent).toMatchObject([{ type: 'setting.set', key: CROSSFADE_SECONDS_SETTING_KEY, value: '7' }]);
    expect(store.settings.get('settings.lastFmApiKey')).toBe('key'); // saved locally as always
  });

  it('keeps only the newest waiting value for a setting', async () => {
    // Offline: nothing can be sent, so the changes wait in the queue.
    const offline = new ServerMode({ store: new MemoryStore(), deviceName: () => 'x', fetch: () => Promise.reject(new TypeError('offline')) });
    await offline.ready;
    await offline.mutations.enqueue({ type: 'setting.set', key: CROSSFADE_SECONDS_SETTING_KEY, value: '3' });
    await offline.mutations.enqueue({ type: 'setting.set', key: CROSSFADE_SECONDS_SETTING_KEY, value: '4' });
    await offline.mutations.enqueue({ type: 'setting.set', key: THEME_MODE_SETTING_KEY, value: 'dark' });
    expect(offline.mutations.getState().pending).toBe(2);
  });
});

import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import type { TypedStartListening, UnknownAction } from '@reduxjs/toolkit';
import type { Dispatch } from '@reduxjs/toolkit';
import type { RootState } from './rootReducer';
import type { Services } from './services';
import { playbackPatched } from './persistence/persistenceSlice';
import { settingsLoaded, settingsUpdated } from './settings/settingsSlice';
import { serializeSettingsPatch, SYNCED_SETTING_KEYS } from './settings/settingsStorage';

export type AppStartListening = TypedStartListening<RootState, Dispatch<UnknownAction>, Services>;

/**
 * Reactive side effects that follow state changes (persistence, syncing
 * into services). Reducers stay pure; each listener reaches I/O only through
 * the injected Services.
 */
export function createAppListenerMiddleware(services: Services) {
  const listenerMiddleware = createListenerMiddleware({ extra: services });
  const startListening = listenerMiddleware.startListening as AppStartListening;

  startListening({
    actionCreator: settingsUpdated,
    effect: (action, { extra }) => {
      for (const [key, value] of serializeSettingsPatch(action.payload)) {
        void extra.libraryStore.putSetting(key, value);
        // Signed in to a server: the account-wide preferences follow the person to their other devices.
        if (extra.serverMode?.isActive() && SYNCED_SETTING_KEYS.has(key)) void extra.serverMode.mutations.enqueue({ type: 'setting.set', key, value });
      }
    },
  });

  // Writes the merged playback state. A debounced patch delays only the write
  // (coalescing e.g. a volume drag's burst); any newer patch cancels a pending
  // delayed write first, and its own write carries the full merged state, so
  // nothing is lost.
  startListening({
    actionCreator: playbackPatched,
    effect: async (action, api) => {
      api.cancelActiveListeners();
      if (!api.getState().persistence.ready) return;
      if (action.payload.debounceMs) await api.delay(action.payload.debounceMs);
      const state = api.getState().persistence.state;
      await api.extra.libraryStore.putPlaybackState(state);
      // Signed in to a server: the person's other devices can offer to continue this.
      api.extra.serverMode?.pushPlaybackState(state);
    },
  });

  // The player is a long-lived service built before the store, so a changed
  // setting has to be pushed into it. Applied on hydration too, since the
  // player starts from a compile-time default.
  startListening({
    matcher: isAnyOf(settingsLoaded, settingsUpdated),
    effect: (action, { extra, getState }) => {
      if (settingsUpdated.match(action) && action.payload.crossfadeSeconds === undefined) return;
      extra.playlistPlayer.setCrossfadeSeconds(getState().settings.values.crossfadeSeconds);
    },
  });

  return listenerMiddleware;
}

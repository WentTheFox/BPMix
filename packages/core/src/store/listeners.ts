import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import type { TypedStartListening, UnknownAction } from '@reduxjs/toolkit';
import type { Dispatch } from '@reduxjs/toolkit';
import type { RootState } from './rootReducer';
import type { Services } from './services';
import { playbackPatched } from './persistence/persistenceSlice';
import { settingsLoaded, settingsUpdated } from './settings/settingsSlice';
import { serializeSettingsPatch } from './settings/settingsStorage';

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
      await api.extra.libraryStore.putPlaybackState(api.getState().persistence.state);
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

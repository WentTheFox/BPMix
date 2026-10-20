import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import type { TypedStartListening, UnknownAction } from '@reduxjs/toolkit';
import type { Dispatch } from '@reduxjs/toolkit';
import type { RootState } from './rootReducer';
import type { Services } from './services';
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

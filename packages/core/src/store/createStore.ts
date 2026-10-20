import { configureStore } from '@reduxjs/toolkit';
import { createAppListenerMiddleware } from './listeners';
import { coarsePlaybackEqual, playbackSynced, toCoarsePlayback } from './playback/playbackSlice';
import { rootReducer } from './rootReducer';
import type { RootState } from './rootReducer';
import type { Services } from './services';

/** Slices holding whole scanned libraries / open playlists: plain data straight from LibraryStore, too big to walk on every dispatch. */
const LARGE_STATE_PATHS = ['library.roots', 'navigation.screen', 'navigation.playingContext'];

/**
 * Builds the app's single store. Services are the thunk and listener
 * `extraArgument`, so nothing in state or reducers touches I/O.
 *
 * State must stay serializable (no Map/Set/functions - see the plan for the
 * side registries that hold those), which the default serializable and
 * immutable checks enforce in development.
 */
export function createStore(services: Services) {
  const listenerMiddleware = createAppListenerMiddleware(services);
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        thunk: { extraArgument: services },
        serializableCheck: { ignoredPaths: LARGE_STATE_PATHS },
        immutableCheck: { ignoredPaths: LARGE_STATE_PATHS },
      }).prepend(listenerMiddleware.middleware),
  });
  // Mirror the player's coarse state into the store - only when it actually
  // changed, so the 5Hz position ticks never touch redux.
  services.livePlayback.subscribe((state) => {
    const coarse = toCoarsePlayback(state);
    if (!coarsePlaybackEqual(coarse, store.getState().playback.coarse)) store.dispatch(playbackSynced(coarse));
  });
  return store;
}

export type AppStore = ReturnType<typeof createStore>;
export type AppDispatch = AppStore['dispatch'];

/** Config for typing `createAsyncThunk` with this store's state, dispatch and services. */
export interface AppThunkConfig {
  state: RootState;
  dispatch: AppDispatch;
  extra: Services;
}

import { configureStore } from '@reduxjs/toolkit';
import { createAppListenerMiddleware } from './listeners';
import { rootReducer } from './rootReducer';
import type { RootState } from './rootReducer';
import type { Services } from './services';

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
  return configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        thunk: { extraArgument: services },
        // The scanned library can be tens of thousands of records; walking it
        // on every dispatch is real cost, and it's plain data straight from
        // LibraryStore anyway.
        serializableCheck: { ignoredPaths: ['library.roots'] },
        immutableCheck: { ignoredPaths: ['library.roots'] },
      }).prepend(listenerMiddleware.middleware),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type AppDispatch = AppStore['dispatch'];

/** Config for typing `createAsyncThunk` with this store's state, dispatch and services. */
export interface AppThunkConfig {
  state: RootState;
  dispatch: AppDispatch;
  extra: Services;
}

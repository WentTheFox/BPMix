import { combineSlices, configureStore } from '@reduxjs/toolkit';
import type { Services } from './services';

/**
 * Add each feature slice here as it migrates (see the store migration plan).
 * Slices own their own state shape; this just composes them.
 */
export const rootReducer = combineSlices();

export type RootState = ReturnType<typeof rootReducer>;

/**
 * Builds the app's single store. Services are the thunk `extraArgument`,
 * so nothing in state or reducers touches I/O.
 *
 * State must stay serializable (no Map/Set/functions - see the plan for the
 * side registries that hold those), which the default serializable and
 * immutable checks enforce in development.
 */
export function createStore(services: Services) {
  return configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ thunk: { extraArgument: services } }),
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

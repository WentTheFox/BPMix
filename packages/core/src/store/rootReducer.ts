import { combineSlices } from '@reduxjs/toolkit';
import { librarySlice } from './library/librarySlice';
import { navigationSlice } from './navigation/navigationSlice';
import { notificationsSlice } from './notifications/notificationsSlice';
import { persistenceSlice } from './persistence/persistenceSlice';
import { playbackSlice } from './playback/playbackSlice';
import { restoreSlice } from './restore/restoreSlice';
import { settingsSlice } from './settings/settingsSlice';

/**
 * Add each feature slice here as it migrates (see the store migration plan).
 * Slices own their own state shape; this just composes them.
 */
export const rootReducer = combineSlices(settingsSlice, notificationsSlice, navigationSlice, librarySlice, playbackSlice, persistenceSlice, restoreSlice);

export type RootState = ReturnType<typeof rootReducer>;

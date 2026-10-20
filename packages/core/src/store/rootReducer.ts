import { combineSlices } from '@reduxjs/toolkit';
import { notificationsSlice } from './notifications/notificationsSlice';
import { settingsSlice } from './settings/settingsSlice';

/**
 * Add each feature slice here as it migrates (see the store migration plan).
 * Slices own their own state shape; this just composes them.
 */
export const rootReducer = combineSlices(settingsSlice, notificationsSlice);

export type RootState = ReturnType<typeof rootReducer>;

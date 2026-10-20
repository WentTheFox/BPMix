import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '@bpmix/core';

/** Typed `useDispatch` for the app store - prefer this over the bare react-redux hook. */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();

/** Typed `useSelector` for the app store. Keep selectors narrow so a component only re-renders for the state it reads. */
export const useAppSelector = useSelector.withTypes<RootState>();

import type { BackgroundTicks } from '@beatseam/core';
import { AppState, NativeEventEmitter, NativeModules } from 'react-native';

interface NativeBackgroundTicks {
  start(intervalMs: number): void;
  stop(): void;
}

const native = NativeModules.BeatseamBackgroundTicks as NativeBackgroundTicks;

/**
 * React Native's timers pause while the app is in the background, which froze everything the playback
 * ticker drives while music kept playing (see BeatseamBackgroundTicksModule.kt). A native timer takes over
 * for as long as the app is backgrounded.
 */
export function createBackgroundTicks(): BackgroundTicks {
  const events = new NativeEventEmitter(NativeModules.BeatseamBackgroundTicks);
  return {
    isBackground: () => AppState.currentState === 'background',
    subscribe: (callback) => {
      const subscription = AppState.addEventListener('change', (state) => callback(state === 'background'));
      return () => subscription.remove();
    },
    start: (intervalMs, callback) => {
      const subscription = events.addListener('BeatseamBackgroundTick', callback);
      native.start(intervalMs);
      return () => {
        subscription.remove();
        native.stop();
      };
    },
  };
}

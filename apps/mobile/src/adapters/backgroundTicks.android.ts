import type { BackgroundTicks } from '@bpmix/core';
import { AppState, NativeEventEmitter, NativeModules } from 'react-native';

interface NativeBackgroundTicks {
  start(intervalMs: number): void;
  stop(): void;
}

const native = NativeModules.BPMixBackgroundTicks as NativeBackgroundTicks;

/**
 * React Native's timers pause while the app is in the background, which froze everything the playback
 * ticker drives while music kept playing (see BPMixBackgroundTicksModule.kt). A native timer takes over
 * for as long as the app is backgrounded.
 */
export function createBackgroundTicks(): BackgroundTicks {
  const events = new NativeEventEmitter(NativeModules.BPMixBackgroundTicks);
  return {
    isBackground: () => AppState.currentState === 'background',
    subscribe: (callback) => {
      const subscription = AppState.addEventListener('change', (state) => callback(state === 'background'));
      return () => subscription.remove();
    },
    start: (intervalMs, callback) => {
      const subscription = events.addListener('BPMixBackgroundTick', callback);
      native.start(intervalMs);
      return () => {
        subscription.remove();
        native.stop();
      };
    },
  };
}

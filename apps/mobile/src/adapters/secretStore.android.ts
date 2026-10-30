import type { SecretStore } from '@bpmix/core';
import { NativeModules } from 'react-native';

interface NativeSecretStore {
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

const native = NativeModules.BPMixSecretStore as NativeSecretStore;

/** One named secret in the Android Keystore (BPMixSecretStoreModule.kt). */
export function createSecretStore(name: string): SecretStore {
  return {
    get: () => native.getSecret(name),
    set: (value) => (value === null ? native.deleteSecret(name) : native.setSecret(name, value)),
  };
}

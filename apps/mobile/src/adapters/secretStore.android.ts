import type { SecretStore } from '@beatseam/core';
import { NativeModules } from 'react-native';

interface NativeSecretStore {
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

const native = NativeModules.BeatseamSecretStore as NativeSecretStore;

/** One named secret in the Android Keystore (BeatseamSecretStoreModule.kt). */
export function createSecretStore(name: string): SecretStore {
  return {
    get: () => native.getSecret(name),
    set: (value) => (value === null ? native.deleteSecret(name) : native.setSecret(name, value)),
  };
}

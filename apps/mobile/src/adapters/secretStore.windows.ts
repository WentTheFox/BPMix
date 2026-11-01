import type { SecretStore } from '@beatseam/core';

/** Windows never signs in to a server yet (see the Server mode TODO in CLAUDE.md), so there is nothing to protect here. */
export function createSecretStore(_name?: string): SecretStore | undefined {
  return undefined;
}

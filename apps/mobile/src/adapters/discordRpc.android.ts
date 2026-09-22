import type { DiscordPresenceBridge } from '@bpmix/core';
import { NativeModules } from 'react-native';

interface NativeDiscordRpc {
  connect(applicationId: string): Promise<boolean>;
  sendFrame(frame: string): Promise<boolean>;
  disconnect(): Promise<void>;
}

const native = NativeModules.BPMixDiscordRpc as NativeDiscordRpc;

/** Thin wrapper over DiscordRpcModule.kt - see DiscordPresenceBridge's doc for the contract this fulfills. */
export function createDiscordPresenceBridge(): DiscordPresenceBridge | null {
  return {
    connect: (applicationId) => native.connect(applicationId).catch(() => false),
    sendFrame: (frame) => native.sendFrame(frame).catch(() => false),
    disconnect: () => native.disconnect().catch(() => undefined),
  };
}

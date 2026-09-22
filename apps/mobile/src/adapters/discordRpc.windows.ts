import type { DiscordPresenceBridge } from '@bpmix/core';

/**
 * No native module yet - Windows Discord Rich Presence needs a C++/WinRT
 * module opening `\\?\pipe\discord-ipc-0` and speaking the same SET_ACTIVITY
 * frame protocol as the Android bridge (see packages/core/src/discord/
 * richPresence.ts), which hasn't been written (see CLAUDE.md's TODO).
 * Returning null rather than a bridge that throws lets the caller treat
 * "no Discord presence on this platform" the same way it already treats
 * "no app-update bridge on Windows" (see appUpdate.windows.ts).
 */
export function createDiscordPresenceBridge(): DiscordPresenceBridge | null {
  return null;
}

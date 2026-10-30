import { randomInt } from 'node:crypto';
import { hashToken } from './tokens.js';

// No 0/O/1/I/L, which get misread when copied off paper.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

/** `XXXX-XXXX`: a short code a person reads off one screen and types into another (device sign-in). */
export function generateUserCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)]!;
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
}

/** `XXXXX-XXXXX`: 10 characters from a 31-symbol alphabet, about 49 bits. */
export function generateRecoveryCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)]!;
  return `${Array.from({ length: 5 }, pick).join('')}-${Array.from({ length: 5 }, pick).join('')}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}

/** Case, dashes and spaces don't matter when typing a code back in. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return hashToken(normalizeRecoveryCode(code));
}

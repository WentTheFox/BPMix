import { hash, verify } from '@node-rs/argon2';

// OWASP's argon2id baseline (19 MiB, 2 passes, 1 lane).
// algorithm 2 is Algorithm.Argon2id; the package's enum is an ambient `const enum`, which isolatedModules can't import.
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** False for a wrong password and for a malformed stored hash alike. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

// A real hash of a throwaway password, verified against when the user doesn't exist so a login
// for an unknown username takes as long as one for a real user.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordTime(password: string): Promise<void> {
  dummyHash ??= hashPassword('beatseam-dummy-password');
  await verifyPassword(await dummyHash, password);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A random url-safe id (22 characters, ~130 bits) for things the client names itself - queued operations
 * and playlists created offline. Not a secret: uniqueness is what matters, so where the platform has no
 * crypto source (React Native without a polyfill) it falls back to Math.random.
 */
export function randomId(length = 22): string {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (source?.getRandomValues) source.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join('');
}

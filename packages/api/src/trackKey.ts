/**
 * Track ids are core's `fileId`s (`${rootId}:${relativePath}`), which contain
 * `/` and `:` - awkward in a URL path segment (reverse proxies commonly
 * reject an encoded `%2F`). The API therefore exposes them as an opaque
 * base64url "key" and the server decodes it back.
 */
export function encodeTrackKey(fileId: string): string {
  const bytes = new TextEncoder().encode(fileId);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTrackKey(key: string): string {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

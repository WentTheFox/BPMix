import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from './encoding';

/**
 * Track ids are core's `fileId`s (`${rootId}:${relativePath}`), which contain
 * `/` and `:` - awkward in a URL path segment (reverse proxies commonly
 * reject an encoded `%2F`). The API therefore exposes them as an opaque
 * base64url "key" and the server decodes it back.
 */
export function encodeTrackKey(fileId: string): string {
  return base64UrlEncode(utf8Encode(fileId));
}

export function decodeTrackKey(key: string): string {
  return utf8Decode(base64UrlDecode(key));
}

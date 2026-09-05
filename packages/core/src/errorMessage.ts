/**
 * Extracts a human-readable message from a caught value for display. Needed
 * because react-native-windows native module rejections come back as plain
 * `{code, message, userInfo}` objects rather than `Error` instances (unlike
 * Android/iOS, where RN wraps native rejections in a real `Error`) - naively
 * calling `String(err)` on one of those gives the useless "[object Object]"
 * instead of the actual native-side failure message.
 */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

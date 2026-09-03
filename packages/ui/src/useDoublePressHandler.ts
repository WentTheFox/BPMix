import { useCallback, useRef } from 'react';

const DOUBLE_PRESS_DELAY_MS = 300;

/** Single press fires onSingle after a short delay; a second press within that window fires onDouble instead. */
export function useDoublePressHandler(onSingle: () => void, onDouble: () => void): () => void {
  const pendingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (pendingTimeout.current) {
      clearTimeout(pendingTimeout.current);
      pendingTimeout.current = null;
      onDouble();
      return;
    }
    pendingTimeout.current = setTimeout(() => {
      pendingTimeout.current = null;
      onSingle();
    }, DOUBLE_PRESS_DELAY_MS);
  }, [onSingle, onDouble]);
}

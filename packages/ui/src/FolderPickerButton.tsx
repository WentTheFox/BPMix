import { useCallback, useRef, useState } from 'react';
import { AddFolderButton } from './AddFolderButton';
import type { Colors } from './theme';

export interface FolderPickerButtonProps {
  colors: Colors;
  icon: string;
  text: string;
  /**
   * The full pick-and-handle operation (e.g. requestRoot() -> scanRoot() ->
   * refresh(), or requestRoot('lyrics') -> addLyricsScope() -> refresh()).
   * Guarded internally against a double-click/double-tap firing it twice
   * concurrently - on Windows specifically, two concurrent WinRT
   * FolderPicker.PickSingleFolderAsync calls against the same window handle
   * have been observed to leave the broker in a bad state, surfacing later
   * as an unrelated-looking "The file is in use" error during a scan.
   */
  onPress: () => Promise<void>;
  /**
   * External busy state layered on top of the picking-in-flight disable
   * below, for a caller-tracked later phase (e.g. scanning a newly-picked
   * root) that has real progress worth showing - swaps the button's label
   * for a spinner + busyText. Leave unset for an operation with no such
   * phase (e.g. picking a lyrics folder - it's just the picker prompt plus
   * a fast metadata write, nothing worth a progress spinner for).
   */
  busy?: boolean;
  busyText?: string;
}

/**
 * AddFolderButton plus the double-invocation guard and "disabled while
 * picking" state every caller (Add Folder, Add Lyrics Folder, on both
 * mobile and web) needs around it - see onPress's doc for why the guard
 * exists. A ref (not just the isPicking state below, which only starts
 * reflecting anything once React has actually committed it) is what closes
 * the window between the first tap and the picker prompt appearing, since
 * it's checked synchronously - a state flag alone can still race a second
 * real tap landing before React has committed the re-render that disables
 * the button.
 *
 * isPicking drives `disabled`, deliberately kept separate from `busy`
 * above rather than folded together: AddFolderButton's busy branch
 * (spinner + text) was observed going blank on Windows and staying that
 * way after the native picker prompt closed, when picking-in-flight was
 * briefly wired to `busy` instead of `disabled` - see AddFolderButton's
 * `disabled` doc for the fuller explanation.
 *
 * Kept separate from AddFolderButton itself (which stays a plain, fully-
 * controlled presentational component) so a caller that doesn't need this
 * async-guard behavior isn't forced to take it.
 */
export function FolderPickerButton({ colors, icon, text, onPress, busy, busyText }: FolderPickerButtonProps) {
  const inFlightRef = useRef(false);
  const [isPicking, setIsPicking] = useState(false);

  const handlePress = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsPicking(true);
    void onPress().finally(() => {
      inFlightRef.current = false;
      setIsPicking(false);
    });
  }, [onPress]);

  return (
    <AddFolderButton
      colors={colors}
      icon={icon}
      text={text}
      onPress={handlePress}
      busy={busy}
      busyText={busyText}
      disabled={isPicking || busy}
    />
  );
}

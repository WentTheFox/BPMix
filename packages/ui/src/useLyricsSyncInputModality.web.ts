import { useEffect, useRef, useState } from 'react';
import type { SyncInputModality, SyncKeyboardActions } from './useLyricsSyncInputModality';

export type { SyncInputModality, SyncKeyboardActions } from './useLyricsSyncInputModality';

/**
 * Tracks which input LyricsSyncScreen's legend should show icons for, and
 * wires the arrow-key equivalents of its swipe gestures - a web/desktop
 * browser can switch between touch and mouse/keyboard mid-session (a
 * touchscreen laptop, say), so this reacts to whichever was used most
 * recently rather than a one-time guess at mount. `touchstart`/`touchmove`
 * switch to 'touch'; `mousemove` or any `keydown` switch to 'keyboard' -
 * mouse movement counts even without a click, since just moving the mouse
 * already tells you touch isn't what's being used right now.
 *
 * The actual keydown handling lives in its own effect (gated by `disabled`,
 * e.g. while saving) rather than reusing the modality-detection listener,
 * since the two need different lifetimes - detection always listens so it
 * can switch back when the user's hands change, but the gesture bindings
 * themselves must stop responding the moment the caller says to.
 *
 * Arrow-key direction deliberately mirrors "scroll" semantics, not "swipe"
 * ones: swipe up drags content up the way scrolling down a page does
 * (content-follows-finger), so swipe-up and the Down arrow key both mean
 * the same thing here (insert break) even though they point opposite ways -
 * see LyricsSyncScreen's own doc for the swipe-direction reasoning this
 * mirrors.
 *
 * Left/Right and Delete/Backspace borrow lrc.seinopsys.dev's own desktop
 * scheme (seeking on the arrow keys, clearing/dropping a line on
 * Delete) rather than reusing Left/Right for skip the way the touch
 * gesture does - a keyboard user reaching for Left/Right almost certainly
 * wants to nudge playback, the same instinct a media player's own seek
 * keys satisfy, and losing that to "skip" would be a worse trade than
 * moving skip to a less-reached-for key.
 */
export function useLyricsSyncInputModality(actions: SyncKeyboardActions, disabled: boolean): SyncInputModality {
  const [modality, setModality] = useState<SyncInputModality>('touch');
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const toTouch = () => setModality('touch');
    const toKeyboard = () => setModality('keyboard');
    window.addEventListener('touchstart', toTouch, { passive: true });
    window.addEventListener('touchmove', toTouch, { passive: true });
    window.addEventListener('mousemove', toKeyboard);
    window.addEventListener('keydown', toKeyboard);
    return () => {
      window.removeEventListener('touchstart', toTouch);
      window.removeEventListener('touchmove', toTouch);
      window.removeEventListener('mousemove', toKeyboard);
      window.removeEventListener('keydown', toKeyboard);
    };
  }, []);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          actionsRef.current.back();
          break;
        case 'ArrowDown':
          e.preventDefault();
          actionsRef.current.break();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          actionsRef.current.seek(e.shiftKey ? -10 : -5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          actionsRef.current.seek(e.shiftKey ? 10 : 5);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          actionsRef.current.skip();
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          actionsRef.current.mark();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [disabled]);

  return modality;
}

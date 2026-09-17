import { useEffect, useRef, useState } from 'react';
import { PanResponder, type GestureResponderEvent, type LayoutChangeEvent, type PanResponderInstance } from 'react-native';

/**
 * Per-move-tick finger movement (px) at or below which the incremental gain
 * bottoms out at MIN_GAIN - a near-motionless drag should barely nudge the
 * value, which is what actually lets a user creep onto one exact percentage
 * instead of the value jumping straight to wherever their finger literally
 * is (the old VOLUME_STEP=0.02 hard snap papered over this same problem by
 * just accepting a coarse grid instead of finer, gesture-aware control).
 */
const FINE_MOVE_PX = 2;
/** Per-move-tick movement (px) at or above which the gain is back to a full 1:1 - a normal-speed or fast drag covers the whole track exactly like a direct absolute-position mapping would, so a deliberate full-range swipe never feels sluggish. */
const FULL_GAIN_MOVE_PX = 14;
/** Gain floor at/below FINE_MOVE_PX - not 0, so a dead-slow drag still visibly (if slowly) moves rather than feeling stuck/unresponsive. */
const MIN_GAIN = 0.2;

/** Linear ramp from MIN_GAIN to 1 as the current move tick's own pixel delta grows from FINE_MOVE_PX to FULL_GAIN_MOVE_PX - see the constants' own docs for why a ramp (not a hard on/off threshold) is worth the extra step: it avoids a jarring snap in feel right at the boundary. */
function gainForTickDelta(absDeltaPx: number): number {
  if (absDeltaPx >= FULL_GAIN_MOVE_PX) return 1;
  if (absDeltaPx <= FINE_MOVE_PX) return MIN_GAIN;
  const t = (absDeltaPx - FINE_MOVE_PX) / (FULL_GAIN_MOVE_PX - FINE_MOVE_PX);
  return MIN_GAIN + (1 - MIN_GAIN) * t;
}

export interface UseDraggableSliderValueInput {
  /** Which screen axis a finger's movement maps to. */
  axis: 'horizontal' | 'vertical';
  /** Vertical only: true (the default, matching VolumeSlider's fader) means top of the track = 1, bottom = 0. Ignored for 'horizontal', which is always left = 0, right = 1. */
  invertVertical?: boolean;
  value: number;
  onChangeValue: (value: number) => void;
}

export interface UseDraggableSliderValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trackRef: React.RefObject<any>;
  /** The live drag position while a gesture is in flight, falling back to `value` otherwise - render this, not `value` directly, so the fill/knob/label track the finger immediately instead of waiting for it to round-trip back down through props (same idea as SeekBar's previewFraction). */
  displayValue: number;
  onLayout: (event: LayoutChangeEvent) => void;
  panHandlers: PanResponderInstance['panHandlers'];
}

/**
 * Shared drag-to-set-a-[0,1]-value gesture, used by both VolumeSlider
 * (vertical, VolumeButton's popover fader) and HorizontalVolumeSlider (the
 * Settings screen's row) - previously two near-identical PanResponders that
 * mapped absolute finger position straight to a value, hard-snapped to
 * VOLUME_STEP (0.02) multiples so a value could actually be hit exactly.
 * That snap made every drag feel equally coarse regardless of how
 * carefully a user was actually moving - useful for "roughly set it and
 * move on" but fighting anyone trying to land on one exact percentage.
 *
 * This replaces the snap with gesture-aware damping instead: an initial
 * tap/grant still jumps straight to the touched position (an unambiguous
 * "big" gesture - see absoluteFractionFromEvent), but every subsequent
 * move tick's contribution to the value is scaled by that tick's own
 * pixel-delta size (see gainForTickDelta) - a fast/normal drag still
 * covers the whole track like a direct mapping would, while a
 * slowed-to-a-crawl drag creeps the value by a fraction of a percent per
 * pixel, making it actually possible to walk onto one exact value instead
 * of hunting back and forth across a 2%-wide dead zone. The value itself
 * is left as a continuous float - nothing here rounds/snaps it to any
 * grid; callers already round only for display (e.g. `Math.round(value *
 * 100)}%`), which is the one place a whole-percent granularity actually
 * matters.
 */
export function useDraggableSliderValue({
  axis,
  invertVertical = true,
  value,
  onChangeValue,
}: UseDraggableSliderValueInput): UseDraggableSliderValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const sizeRef = useRef(0);
  const pageOffsetRef = useRef(0);
  // The finger's own last raw page position, for computing this move
  // tick's delta - distinct from workingValueRef below (that one tracks
  // the value the delta gets applied to).
  const lastPagePosRef = useRef(0);
  // The value each move tick accumulates onto, updated imperatively on
  // every tick rather than read back from the `value` prop - a fast
  // sequence of PanResponder move events can fire well within one React
  // render/prop round-trip, and computing each tick's delta against a
  // prop that hasn't caught up yet would silently drop every delta but
  // the last one in that batch.
  const workingValueRef = useRef(value);
  const onChangeRef = useRef(onChangeValue);
  useEffect(() => {
    onChangeRef.current = onChangeValue;
  }, [onChangeValue]);

  const [dragValue, setDragValue] = useState<number | null>(null);
  const displayValue = dragValue ?? value;

  const measure = () => {
    trackRef.current?.measure((_x: number, _y: number, width: number, height: number, pageX: number, pageY: number) => {
      sizeRef.current = axis === 'horizontal' ? width : height;
      pageOffsetRef.current = axis === 'horizontal' ? pageX : pageY;
    });
  };

  const onLayout = () => measure();

  // pageX/pageY (not locationX/locationY) throughout, same reasoning as
  // SeekBar/VolumeSlider's own prior comments on this: a drag routinely
  // carries the touch outside a narrow track's bounds, and locationX/Y is
  // re-hit-tested against whatever's currently underneath the finger on
  // every move event rather than staying locked to the view that became
  // the responder - producing jumpy/backwards deltas once the finger
  // wanders off the track. pageX/Y is an absolute screen coordinate
  // regardless of what's hit-tested, so a delta between two consecutive
  // pageX/Y readings stays correct however far outside the track the drag
  // wanders.
  const pagePos = (event: GestureResponderEvent) => (axis === 'horizontal' ? event.nativeEvent.pageX : event.nativeEvent.pageY);

  const absoluteFractionFromEvent = (event: GestureResponderEvent): number | null => {
    if (sizeRef.current <= 0) return null;
    const relative = pagePos(event) - pageOffsetRef.current;
    if (!Number.isFinite(relative)) return null;
    const raw = Math.max(0, Math.min(1, relative / sizeRef.current));
    if (axis === 'horizontal') return raw;
    return invertVertical ? 1 - raw : raw;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        measure();
        lastPagePosRef.current = pagePos(event);
        const fraction = absoluteFractionFromEvent(event);
        if (fraction == null) return;
        workingValueRef.current = fraction;
        setDragValue(fraction);
        onChangeRef.current(fraction);
      },
      onPanResponderMove: (event) => {
        if (sizeRef.current <= 0) return;
        const pos = pagePos(event);
        const rawDeltaPx = pos - lastPagePosRef.current;
        lastPagePosRef.current = pos;
        if (!Number.isFinite(rawDeltaPx) || rawDeltaPx === 0) return;
        const gain = gainForTickDelta(Math.abs(rawDeltaPx));
        let deltaFraction = rawDeltaPx / sizeRef.current;
        if (axis === 'vertical' && invertVertical) deltaFraction = -deltaFraction;
        const next = Math.max(0, Math.min(1, workingValueRef.current + deltaFraction * gain));
        workingValueRef.current = next;
        setDragValue(next);
        onChangeRef.current(next);
      },
      onPanResponderRelease: () => setDragValue(null),
      onPanResponderTerminate: () => setDragValue(null),
    }),
  ).current;

  return { trackRef, displayValue, onLayout, panHandlers: panResponder.panHandlers };
}

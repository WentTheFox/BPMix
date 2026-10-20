import type { LyricLine } from '@bpmix/core';
import {
  mdiArrowDownBold,
  mdiArrowUpBold,
  mdiBackspaceOutline,
  mdiFastForward5,
  mdiGestureSwipeDown,
  mdiGestureSwipeHorizontal,
  mdiGestureSwipeUp,
  mdiGestureTap,
  mdiKeyboardReturn,
  mdiPlaylistPlus,
  mdiRewind5,
  mdiTrashCanOutline,
  mdiUndo,
} from '@mdi/js';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, type LayoutChangeEvent, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatSeconds } from './formatSeconds';
import { Icon } from './Icon';
import { SeekBar } from './SeekBar';
import { withAlpha, type Colors } from './theme';
import { useLyricsSyncInputModality } from './useLyricsSyncInputModality';

/** Below this, a gesture reads as a tap rather than a swipe in any direction. */
const SWIPE_THRESHOLD_PX = 24;

/** How far (px) a live drag has to travel before its visual preview (fade/grow/shrink) reaches full intensity - independent of SWIPE_THRESHOLD_PX, which only decides what happens on release. Larger than the release threshold on purpose: the preview should still be ramping up, not already maxed out, right around the point where releasing would commit it. */
const DRAG_PREVIEW_COMMIT_PX = 110;

/** Clamps how far the current-line box visually slides under a live drag, regardless of how far the finger actually travels - keeps it readable instead of flying off past the edge. */
const DRAG_MAX_SLIDE_PX = 48;

/** Full-grown thickness of an edge reveal bar (see topRevealSize and friends) - an email-swipe-style accent strip that grows in from whichever edge a drag is heading toward, labeled with the pending action. */
const REVEAL_BAR_MAX_PX = 72;

/** How many upcoming lines to preview below the current one, fading out toward the bottom - lets you read ahead instead of seeing only the very next line. */
const UPCOMING_PREVIEW_COUNT = 5;

/** Width of each edge-of-screen seek zone inside tapArea - narrow enough to leave the swipe/mark gesture area untouched in the middle, wide enough to be an easy thumb target. */
const EDGE_ZONE_WIDTH_PX = 64;

/** Seconds nudged per tap on an edge zone, or per tick while holding one down - see startFastSeek. Multiplied by how many taps deep into a streak a given tap is - see handleEdgeTap. */
const EDGE_SEEK_STEP_SECONDS = 5;

/** A same-direction edge tap within this long of the previous one continues the streak (multiplying the seek step) instead of starting a fresh one. */
const EDGE_TAP_STREAK_WINDOW_MS = 700;

/** How often a held-down edge zone fires another seek step. */
const EDGE_FAST_SEEK_INTERVAL_MS = 200;

export interface LyricsSyncScreenProps {
  colors: Colors;
  /** The shared entries array LyricsEditorScreen owns - this screen only mutates it (via onEntriesChange) through the four gestures below, same source LyricsEditScreen's per-line view reads/writes too, so switching between the two mid-pass never loses or resets anything. */
  entries: LyricLine[];
  onEntriesChange: (entries: LyricLine[]) => void;
  /** Live playback position, read at the moment of each tap/gesture - this screen never controls playback itself (see its own doc for why), just reads where it already is. */
  positionSeconds: number;
  /** For the seek bar only - not otherwise used here. */
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
  /** True between the caller's Save firing and the write actually landing - disables input so a second gesture can't fire mid-write. */
  saving?: boolean;
}

/**
 * Tap-to-advance manual lyrics sync (see CLAUDE.md's lyrics-editor TODO) -
 * opened from LyricsSection's "Sync lyrics manually" button for a track
 * whose assigned .lrc is plain/unsynced. Four gestures on the main area:
 *
 * - tap: record positionSeconds as the current line's timestamp, advance
 * - swipe down: go back to the previous line, clearing its timestamp (a
 *   no-op on the first line - nowhere to go back to) - the natural-
 *   scrolling direction for "go back", same as pulling a page down to
 *   reveal what's above it
 * - swipe up: insert a blank timed "break" entry at the current moment
 *   ahead of the current line, for an instrumental gap worth marking -
 *   written out as a plain [mm:ss.xx] tag with no text, a convention
 *   several LRC players already use for exactly this
 * - swipe left or right: drop the current line entirely (a section header
 *   or ad-lib that isn't actually its own sung line) without timing it -
 *   either horizontal direction works, since "skip" has no natural-
 *   scrolling direction of its own the way back/break do
 *
 * The legend row shows one icon per gesture (the swipe direction, not the
 * resulting action - the bottom action buttons already show that) and
 * tapping one pops up a one-line explanation (auto-dismissing) rather than
 * cramming the instructions into a permanent paragraph up top. There's no
 * Save/Cancel of its own here - this screen only mutates the shared
 * `entries` array it's handed (see LyricsEditorScreen, which owns the one
 * Cancel/Save header both modes share), so a gesture here is visible to
 * Edit mode the instant you switch to it, not just once something's saved.
 *
 * Deliberately has no play/pause control of its own - tap-to-sync only
 * makes sense while the track keeps playing underneath it, so the whole
 * premise is that something already started it before this screen opened.
 * Seeking is covered three ways instead: the SeekBar below the legend (tap
 * or drag, same component NowPlayingScreen's own seek row uses), the
 * edge-of-screen zones (see handleEdgeTap/startFastSeek - tap to nudge,
 * hold to fast-seek, the established YouTube/VLC pattern), and Left/Right
 * on a keyboard. Every one of them routes through seekTo, which also jumps
 * the cursor to match wherever you seek to (see jumpCursorToPosition) -
 * without that, seeking back to re-try a line would leave the cursor
 * pointing at whatever line you'd already advanced past, not the one
 * you're now about to hear again. The screen rewinds playback to 0 on open
 * (see the mount effect below) only if nothing's been timed yet anywhere in
 * `entries` - cursor 0 only produces a correct timestamp for line 1 if
 * position 0 actually matches it, which opening this mid-track otherwise
 * wouldn't guarantee. Re-entering Sync after timing a few lines in Edit
 * mode (or on an earlier Sync pass) leaves playback alone instead, since by
 * then there's real progress to preserve, not a blank pass to align.
 *
 * Out of scope for this first pass (see CLAUDE.md's remaining lyrics-editor
 * sub-items): the multi-language translation-timing carry-over case, and
 * the separate whole-file time-shift mode.
 */
export function LyricsSyncScreen({ colors, entries, onEntriesChange, positionSeconds, durationSeconds, onSeekTo, saving }: LyricsSyncScreenProps) {
  // Resumes wherever sync progress (if any) already left off - the first
  // still-untimed entry, or past the end (entries.length) if every entry
  // already has a timestamp - rather than always starting over at 0. This
  // only runs once at mount: entries is shared/controlled, but cursor is
  // this screen's own notion of "where in the pass am I", which the parent
  // has no equivalent of while Edit mode (or nothing) is showing instead.
  const [cursor, setCursor] = useState(() => {
    const firstUntimed = entries.findIndex((entry) => entry.timeSeconds === null);
    return firstUntimed === -1 ? entries.length : firstUntimed;
  });
  // Read inside the PanResponder's release handler via a ref, not the
  // positionSeconds closure captured when the responder was created -
  // PanResponder's handler object is built once (useRef below) and reused
  // across renders, so a plain closure over the prop would see whatever
  // position was current at mount, not at the moment of the actual gesture.
  const positionRef = useRef(positionSeconds);
  positionRef.current = positionSeconds;

  useEffect(() => {
    // See this component's own doc for why this only fires on a genuinely
    // fresh pass (nothing timed anywhere yet), not every time Sync mode is
    // (re)entered.
    if (entries.every((entry) => entry.timeSeconds === null)) onSeekTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finished = cursor >= entries.length;

  const recordTimestamp = () => {
    if (finished) return;
    const next = entries.slice();
    next[cursor] = { ...next[cursor]!, timeSeconds: positionRef.current };
    onEntriesChange(next);
    setCursor(cursor + 1);
  };

  const undoPrevious = () => {
    if (cursor === 0) return;
    const prevCursor = cursor - 1;
    const next = entries.slice();
    next[prevCursor] = { ...next[prevCursor]!, timeSeconds: null };
    onEntriesChange(next);
    setCursor(prevCursor);
  };

  const skipLine = () => {
    if (finished) return;
    const next = entries.slice();
    next.splice(cursor, 1);
    onEntriesChange(next);
  };

  const insertBreak = () => {
    if (finished) return;
    const next = entries.slice();
    next.splice(cursor, 0, { timeSeconds: positionRef.current, text: '' });
    onEntriesChange(next);
    setCursor(cursor + 1);
  };

  // PanResponder.create(...) is built once (useRef below) and reused across
  // renders - a plain closure over recordTimestamp/undoPrevious/skipLine/
  // insertBreak baked directly into onPanResponderRelease would freeze on
  // whichever versions of those existed at mount (cursor/entries always
  // read back as their initial values), so every tap after the very first
  // would silently redo the same first-line action instead of advancing.
  // Routing through a ref that's reassigned every render keeps the handler
  // itself stable (so PanResponder's own identity doesn't change) while
  // always calling into the current render's actual state.
  const actionsRef = useRef({ recordTimestamp, undoPrevious, skipLine, insertBreak });
  actionsRef.current = { recordTimestamp, undoPrevious, skipLine, insertBreak };

  // Live drag position, updated every touch-move frame (not just on
  // release) - drives the preview interpolations below so the current line
  // visibly tracks the finger as it moves, instead of only reacting once
  // the gesture ends. Reset to {0,0} the instant a gesture resolves (via
  // setValue, not an animation) - whichever text is "current" after that
  // reset is already the thing the drag was previewing, so snapping
  // straight to rest reads as the preview completing, not restarting.
  const pan = useRef(new Animated.ValueXY()).current;
  const handlePanMove = useRef(Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false })).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: handlePanMove,
      onPanResponderRelease: (_event, gesture) => {
        const { dx, dy } = gesture;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX && Math.abs(dy) < SWIPE_THRESHOLD_PX) {
          actionsRef.current.recordTimestamp();
          pan.setValue({ x: 0, y: 0 });
        } else if (Math.abs(dy) >= Math.abs(dx)) {
          if (dy < 0) actionsRef.current.insertBreak(); // swipe up
          else actionsRef.current.undoPrevious(); // swipe down
          pan.setValue({ x: 0, y: 0 });
        } else {
          actionsRef.current.skipLine(); // swipe left or right
          pan.setValue({ x: 0, y: 0 });
        }
      },
      // A gesture that ends (or gets interrupted by the OS) without
      // crossing SWIPE_THRESHOLD_PX never reaches onPanResponderRelease's
      // branches above, so the preview needs its own spring back to rest
      // instead of just sitting part-dragged.
      onPanResponderTerminate: () => {
        Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
      },
    }),
  ).current;

  // Seeking (the bar below, the edge zones, or Left/Right on a keyboard)
  // moves playback somewhere that may not match wherever tap-to-sync had
  // gotten to - jump the cursor to match, the exact same rule the regular
  // playback view uses to pick its own highlighted line (currentLyricsLineIndex
  // in LyricsSection.tsx: the last entry, anywhere in the list, whose
  // timestamp has passed). Scans every entry rather than stopping at the
  // first gap, so seeking into a stretch that already has a timestamp -
  // even past an earlier untimed one - lands the cursor directly on that
  // already-timed line (to re-check or re-tap it), not on the first gap
  // encountered on the way there. Seeking somewhere with nothing timed yet
  // at or before it falls back to the first entry, same as today.
  const jumpCursorToPosition = (targetSeconds: number) => {
    let newCursor = 0;
    entries.forEach((entry, index) => {
      if (entry.timeSeconds !== null && entry.timeSeconds <= targetSeconds) newCursor = index;
    });
    setCursor(newCursor);
  };
  const seekTo = (targetSeconds: number) => {
    const clamped = Math.max(0, targetSeconds);
    onSeekTo(clamped);
    jumpCursorToPosition(clamped);
  };
  const seekBy = (deltaSeconds: number) => seekTo(positionRef.current + deltaSeconds);

  // Edge-of-screen seeking (the two narrow strips rendered inside tapArea
  // below) - the established mobile pattern (YouTube/VLC-style). A tap on
  // either edge doesn't seek right away - it joins a running streak (reset
  // whenever EDGE_TAP_STREAK_WINDOW_MS passes without another same-edge
  // tap), shows the streak's total as a "-Ns"/"+Ns" label on the edge
  // itself (edgeSeekPreview) so the user can see how far they're about to
  // jump, and only actually calls seekBy once - debounced to the moment
  // tapping stops - rather than firing a seek per tap and re-targeting
  // mid-flight on every one. Holding the edge down instead fast-seeks
  // continuously (startFastSeek) until released, bypassing the streak
  // entirely - that's already a deliberate continuous action, nothing to
  // batch.
  const edgeTapStreakRef = useRef<{ direction: -1 | 1; count: number; lastTapAt: number } | null>(null);
  const edgeSeekCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [edgeSeekPreview, setEdgeSeekPreview] = useState<{ direction: -1 | 1; totalSeconds: number } | null>(null);
  const handleEdgeTap = (direction: -1 | 1) => {
    const now = Date.now();
    const streak = edgeTapStreakRef.current;
    const count = streak && streak.direction === direction && now - streak.lastTapAt < EDGE_TAP_STREAK_WINDOW_MS ? streak.count + 1 : 1;
    edgeTapStreakRef.current = { direction, count, lastTapAt: now };
    const totalSeconds = EDGE_SEEK_STEP_SECONDS * count;
    setEdgeSeekPreview({ direction, totalSeconds });

    if (edgeSeekCommitTimerRef.current !== null) clearTimeout(edgeSeekCommitTimerRef.current);
    edgeSeekCommitTimerRef.current = setTimeout(() => {
      seekBy(direction * totalSeconds);
      setEdgeSeekPreview(null);
      edgeSeekCommitTimerRef.current = null;
      edgeTapStreakRef.current = null;
    }, EDGE_TAP_STREAK_WINDOW_MS);
  };

  const fastSeekIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopFastSeek = () => {
    if (fastSeekIntervalRef.current !== null) {
      clearInterval(fastSeekIntervalRef.current);
      fastSeekIntervalRef.current = null;
    }
  };
  const startFastSeek = (direction: -1 | 1) => {
    stopFastSeek();
    fastSeekIntervalRef.current = setInterval(() => seekBy(direction * EDGE_SEEK_STEP_SECONDS), EDGE_FAST_SEEK_INTERVAL_MS);
  };
  useEffect(
    () => () => {
      stopFastSeek(); // stop a still-running hold if the screen unmounts mid-press
      if (edgeSeekCommitTimerRef.current !== null) clearTimeout(edgeSeekCommitTimerRef.current); // an unmounted screen can't still commit a pending seek
    },
    [],
  );

  // Which edge zone (if any) currently has a finger down on it - tints that
  // zone with the accent color while held, same idea as the reveal bars
  // above but for "this press is going to seek", not "this drag is going to
  // mark/back/break/skip". A touch that starts on either edge zone belongs
  // to it exclusively (Pressable claims the responder before tapArea's own
  // PanResponder gets a chance, since the zones are children rendered
  // inside tapArea and RN resolves touch responders depth-first) - the
  // swipe/tap gestures only ever see drags that started in the middle.
  const [pressedEdge, setPressedEdge] = useState<-1 | 1 | null>(null);
  // A long press already handles the whole hold-to-fast-seek interaction via
  // startFastSeek/stopFastSeek - without this flag, Pressable still fires
  // onPress once the finger lifts off afterward, which would also start (or
  // extend) an edge-tap streak right as the user lets go of a hold.
  const longPressFiredRef = useRef(false);
  const handleEdgePressIn = (direction: -1 | 1) => {
    longPressFiredRef.current = false;
    setPressedEdge(direction);
  };
  const handleEdgePressOut = () => {
    setPressedEdge(null);
    stopFastSeek();
  };
  const handleEdgeLongPress = (direction: -1 | 1) => {
    longPressFiredRef.current = true;
    startFastSeek(direction);
  };
  const handleEdgePress = (direction: -1 | 1) => {
    if (longPressFiredRef.current) return;
    handleEdgeTap(direction);
  };

  const previousLine = cursor > 0 ? entries[cursor - 1] : null;
  const currentLine = !finished ? entries[cursor] : null;
  const nextLine = !finished && cursor + 1 < entries.length ? entries[cursor + 1] : null;
  const previousText = previousLine ? previousLine.text || '(break)' : null;
  const currentText = currentLine ? currentLine.text || '(break)' : '';
  const nextText = nextLine ? nextLine.text || '(break)' : null;
  // Only the immediate next line ever needs the reserved-height treatment
  // below (it's the only one that can become "current" on the very next
  // step) - everything past it is purely a read-ahead preview.
  const upcomingLines = finished ? [] : entries.slice(cursor + 1, cursor + 1 + UPCOMING_PREVIEW_COUNT);

  // Reserves the current-line box at whichever is taller, current vs next
  // (rendered at the same big/bold style, off-screen, just to measure) -
  // without this, tapping to advance from a short line to a long one (or
  // back) snapped the box's height right as the text changed, which read as
  // a jarring jump rather than a smooth swap. Caching by text content (a
  // useRef map, not state, so writing to it doesn't itself trigger a
  // render) means a line already measured once - typically as "next" the
  // step before it becomes "current" - doesn't need remeasuring right at
  // the moment it's needed; only cacheVersion bumping (on an actually new
  // measurement) triggers the re-render that picks the new height up.
  const lineHeights = useRef(new Map<string, number>()).current;
  const [cacheVersion, setCacheVersion] = useState(0);
  const [tapAreaWidth, setTapAreaWidth] = useState(0);
  const recordLineHeight = (text: string, height: number) => {
    if (lineHeights.get(text) !== height) {
      lineHeights.set(text, height);
      setCacheVersion((v) => v + 1);
    }
  };
  void cacheVersion; // read only to force the re-render above; the cache itself is read straight from the ref below
  // Previous counts too, not just current/next - a down-drag grows it up to
  // this same big/bold size as it becomes the new current line (see the
  // animated interpolations below), so its slot needs the same headroom or
  // that growth would get clipped/reflow the layout mid-drag.
  const reservedLineHeight =
    Math.max(lineHeights.get(currentText) ?? 0, (nextText ? lineHeights.get(nextText) : 0) ?? 0, (previousText ? lineHeights.get(previousText) : 0) ?? 0) || undefined;

  // Live-drag preview interpolations - see the PanResponder's onPanResponderMove
  // above for what feeds pan.x/pan.y. Each pair below is deliberately
  // asymmetric: a down-drag (back) is the only one that actually swaps the
  // current line's content 1:1 with the previous one, so only the positive
  // (downward) half of pan.y drives current/previous's slide+fade+resize -
  // the negative (upward, break) half is pinned to the resting value via the
  // inputRange's -1 breakpoint, since insertBreak never changes what's
  // showing as current (see its own doc) and faking a slide there would
  // visually lie about what's about to happen.
  const currentTranslateY = pan.y.interpolate({ inputRange: [-1, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [0, 0, DRAG_MAX_SLIDE_PX], extrapolate: 'clamp' });
  const currentOpacityY = pan.y.interpolate({ inputRange: [-1, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [1, 1, 0.25], extrapolate: 'clamp' });
  const currentFontSizeY = pan.y.interpolate({ inputRange: [-1, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [22, 22, 15], extrapolate: 'clamp' });
  // previousSlot's own (small) text fades out as its full-size overlay
  // (incomingPreviousOpacity, over in currentLineBox) fades in - it reads as
  // the one piece of text growing from the small slot into the big box, not
  // two separate texts independently appearing/disappearing.
  const previousRestOpacity = pan.y.interpolate({ inputRange: [-1, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [0.6, 0.6, 0], extrapolate: 'clamp' });
  const incomingPreviousOpacity = pan.y.interpolate({ inputRange: [-1, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [0, 0, 1], extrapolate: 'clamp' });
  const previousFontSizeY = pan.y.interpolate({ inputRange: [-1, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [14, 14, 22], extrapolate: 'clamp' });
  // An up-drag (break) never changes the current line itself, only whether
  // the previous slot shows the real previous line or a "(break)" preview -
  // two overlaid texts crossfading by this same progress value, rather than
  // any slide/resize.
  const breakPreviewProgress = pan.y.interpolate({ inputRange: [-DRAG_PREVIEW_COMMIT_PX, 0], outputRange: [1, 0], extrapolate: 'clamp' });

  // Horizontal (skip) drag: current slides out sideways either direction and
  // fades, while a duplicate of the next line - absolutely positioned over
  // the same box - grows in from the small/faded preview size to full
  // current-line size, since skip really does replace current with next 1:1.
  const currentTranslateX = pan.x.interpolate({ inputRange: [-400, 0, 400], outputRange: [-DRAG_MAX_SLIDE_PX, 0, DRAG_MAX_SLIDE_PX], extrapolate: 'clamp' });
  const skipProgress = pan.x.interpolate({ inputRange: [-DRAG_PREVIEW_COMMIT_PX, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [1, 0, 1], extrapolate: 'clamp' });
  const currentOpacityX = Animated.subtract(1, Animated.multiply(skipProgress, 0.75));
  const incomingNextOpacity = skipProgress;
  const incomingNextFontSize = pan.x.interpolate({ inputRange: [-DRAG_PREVIEW_COMMIT_PX, 0, DRAG_PREVIEW_COMMIT_PX], outputRange: [22, 14, 22], extrapolate: 'clamp' });

  // Combined current-line opacity: whichever axis the user is actually
  // dragging on dominates (the other sits near 1, its own resting value) -
  // multiplying keeps both available without needing to branch on which
  // axis is "the real one" for this particular gesture.
  const currentOpacity = Animated.multiply(currentOpacityY, currentOpacityX);

  // Email-swipe-style reveal bars: a solid accent-colored strip grows in
  // from whichever edge the drag is heading toward, labeled with the
  // pending action, so the "what will happen if I let go right now" is
  // obvious mid-drag rather than only discoverable by finishing the
  // gesture. One bar per edge, each driven by only its own half of the
  // relevant axis (same -1/0 trick as the slide/fade interpolations above)
  // so a drag toward one edge never also puffs up the opposite one.
  const topRevealSize = pan.y.interpolate({ inputRange: [-DRAG_PREVIEW_COMMIT_PX, -1, 0], outputRange: [REVEAL_BAR_MAX_PX, 0, 0], extrapolate: 'clamp' });
  const bottomRevealSize = pan.y.interpolate({ inputRange: [0, 1, DRAG_PREVIEW_COMMIT_PX], outputRange: [0, 0, REVEAL_BAR_MAX_PX], extrapolate: 'clamp' });
  const leftRevealSize = pan.x.interpolate({ inputRange: [-DRAG_PREVIEW_COMMIT_PX, -1, 0], outputRange: [REVEAL_BAR_MAX_PX, 0, 0], extrapolate: 'clamp' });
  const rightRevealSize = pan.x.interpolate({ inputRange: [0, 1, DRAG_PREVIEW_COMMIT_PX], outputRange: [0, 0, REVEAL_BAR_MAX_PX], extrapolate: 'clamp' });
  const revealLabelOpacity = (size: Animated.AnimatedInterpolation<number>) => Animated.multiply(size, 1 / REVEAL_BAR_MAX_PX);

  // Tap a legend item to see the one-line explanation of its gesture -
  // auto-dismisses after a few seconds, or immediately on tapping the same
  // (or another) item again. Kept as a single shared slot (not per-item
  // state) since only one can be open at a time anyway.
  const [tooltipKey, setTooltipKey] = useState<string | null>(null);
  useEffect(() => {
    if (!tooltipKey) return;
    const timer = setTimeout(() => setTooltipKey(null), 3500);
    return () => clearTimeout(timer);
  }, [tooltipKey]);
  // Web/desktop only (see useLyricsSyncInputModality's own doc) - switches
  // the legend between swipe-gesture icons and the arrow-key/Enter
  // equivalents depending on whichever input was used most recently. Native
  // platforms always get 'touch' back and never wire the keydown handler at
  // all, since there's no mouse/keyboard input there to detect.
  const inputModality = useLyricsSyncInputModality({ mark: recordTimestamp, back: undoPrevious, break: insertBreak, skip: skipLine, seek: seekBy }, !!saving);
  const legendItems: { key: string; icon: string; label: string; description: string }[] =
    inputModality === 'keyboard'
      ? [
          { key: 'mark', icon: mdiKeyboardReturn, label: 'mark', description: 'Press Enter or Space to mark the current line at the current playback position and move to the next one.' },
          // Arrow-key direction mirrors "scroll", not "swipe" - see
          // useLyricsSyncInputModality.web.ts's own doc for why Down means
          // break and Up means back here, the opposite of which way the
          // matching swipe gesture's finger actually moves.
          { key: 'break', icon: mdiArrowDownBold, label: 'break', description: 'Press ↓ to insert a timed break here, for an instrumental gap worth marking.' },
          { key: 'back', icon: mdiArrowUpBold, label: 'back', description: 'Press ↑ to go back to the previous line and clear its mark.' },
          { key: 'skip', icon: mdiBackspaceOutline, label: 'skip', description: 'Press Delete or Backspace to drop this line entirely, without timing it. ← and → seek the track instead.' },
        ]
      : [
          { key: 'mark', icon: mdiGestureTap, label: 'mark', description: 'Tap anywhere in the lyrics area to mark the current line at the current playback position and move to the next one.' },
          { key: 'break', icon: mdiGestureSwipeUp, label: 'break', description: 'Swipe up to insert a timed break here, for an instrumental gap worth marking.' },
          { key: 'back', icon: mdiGestureSwipeDown, label: 'back', description: 'Swipe down to go back to the previous line and clear its mark.' },
          { key: 'skip', icon: mdiGestureSwipeHorizontal, label: 'skip', description: 'Swipe left or right to drop this line entirely, without timing it.' },
        ];

  return (
    <View style={styles.container}>
      {/* Cancel/Save live once in LyricsEditorScreen's own shared header now,
          not duplicated here - this line-progress readout is the one piece
          of header chrome still specific to Sync mode. */}
      <Text style={[styles.progress, { color: colors.subtleText }]}>{finished ? 'Done' : `Line ${cursor + 1} of ${entries.length}`}</Text>

      <View style={styles.legendRow}>
        {legendItems.map((item) => {
          const isOpen = tooltipKey === item.key;
          const itemColor = isOpen ? colors.accent : colors.subtleText;
          return (
            <Pressable
              key={item.key}
              style={styles.legendItem}
              onPress={() => setTooltipKey((k) => (k === item.key ? null : item.key))}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              accessibilityLabel={item.description}
            >
              <Icon path={item.icon} size={16} color={itemColor} />
              <Text style={[styles.legendText, { color: itemColor }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {tooltipKey && (
        <Text style={[styles.tooltip, { color: colors.text }]}>{legendItems.find((item) => item.key === tooltipKey)!.description}</Text>
      )}

      <View
        style={styles.tapArea}
        {...(saving ? {} : panResponder.panHandlers)}
        onLayout={(e: LayoutChangeEvent) => setTapAreaWidth(e.nativeEvent.layout.width)}
      >
        {/* Edge-of-screen seek zones - see handleEdgeTap/startFastSeek's own
            doc. Rendered first (behind the reveal bars/line content below,
            which paint over the small sliver they'd otherwise overlap) and
            as real Pressables, not part of tapArea's PanResponder, so a drag
            starting here never reaches the mark/swipe gestures. Kept outside
            the saving/finished/active split below (just disabled while
            saving) so seeking still works once every line is synced, not
            only while still mid-pass. */}
        <Pressable
          style={[styles.edgeZone, styles.edgeZoneLeft, pressedEdge === -1 && { backgroundColor: withAlpha(colors.accent, 0.3) }]}
          onPressIn={() => handleEdgePressIn(-1)}
          onPressOut={handleEdgePressOut}
          onLongPress={() => handleEdgeLongPress(-1)}
          onPress={() => handleEdgePress(-1)}
          delayLongPress={450}
          disabled={saving}
          accessibilityLabel="Seek backward"
        >
          {edgeSeekPreview?.direction === -1 ? (
            <Text style={[styles.edgeZoneText, { color: colors.accent }]}>-{edgeSeekPreview.totalSeconds}s</Text>
          ) : (
            <Icon path={mdiRewind5} size={20} color={colors.subtleText} />
          )}
        </Pressable>
        <Pressable
          style={[styles.edgeZone, styles.edgeZoneRight, pressedEdge === 1 && { backgroundColor: withAlpha(colors.accent, 0.3) }]}
          onPressIn={() => handleEdgePressIn(1)}
          onPressOut={handleEdgePressOut}
          onLongPress={() => handleEdgeLongPress(1)}
          onPress={() => handleEdgePress(1)}
          delayLongPress={450}
          disabled={saving}
          accessibilityLabel="Seek forward"
        >
          {edgeSeekPreview?.direction === 1 ? (
            <Text style={[styles.edgeZoneText, { color: colors.accent }]}>+{edgeSeekPreview.totalSeconds}s</Text>
          ) : (
            <Icon path={mdiFastForward5} size={20} color={colors.subtleText} />
          )}
        </Pressable>

        {saving ? (
          <ActivityIndicator color={colors.accent} />
        ) : finished ? (
          <Text style={[styles.currentLine, { color: colors.text }]}>All lines synced</Text>
        ) : (
          <>
            {/* Email-swipe-style reveal bars - see topRevealSize and friends.
                Rendered first (painted behind everything else below) and
                non-interactive, so they never steal the drag gesture from
                tapArea's own PanResponder. */}
            <Animated.View style={[styles.revealBar, styles.revealBarTop, { height: topRevealSize, backgroundColor: colors.accent }]} pointerEvents="none">
              <Animated.Text style={[styles.revealBarText, { opacity: revealLabelOpacity(topRevealSize) }]}>Break</Animated.Text>
            </Animated.View>
            <Animated.View style={[styles.revealBar, styles.revealBarBottom, { height: bottomRevealSize, backgroundColor: colors.accent }]} pointerEvents="none">
              <Animated.Text style={[styles.revealBarText, { opacity: revealLabelOpacity(bottomRevealSize) }]}>Back</Animated.Text>
            </Animated.View>
            <Animated.View style={[styles.revealBar, styles.revealBarLeft, { width: leftRevealSize, backgroundColor: colors.accent }]} pointerEvents="none">
              <Animated.Text style={[styles.revealBarText, { opacity: revealLabelOpacity(leftRevealSize) }]}>Skip</Animated.Text>
            </Animated.View>
            <Animated.View style={[styles.revealBar, styles.revealBarRight, { width: rightRevealSize, backgroundColor: colors.accent }]} pointerEvents="none">
              <Animated.Text style={[styles.revealBarText, { opacity: revealLabelOpacity(rightRevealSize) }]}>Skip</Animated.Text>
            </Animated.View>

            {/* Always reserved, even with nothing to show yet (cursor 0) - a
                swipe-up/break preview needs this slot to fade its "(break)"
                text into regardless, and reserving it unconditionally avoids
                the whole column re-centering the instant it first appears. */}
            <View style={[styles.previousSlot, { minHeight: reservedLineHeight }]}>
              <Animated.Text style={[styles.contextLine, { color: colors.subtleText, opacity: Animated.multiply(previousRestOpacity, Animated.subtract(1, breakPreviewProgress)) }]} numberOfLines={1}>
                {previousText ?? ''}
              </Animated.Text>
              <Animated.Text style={[styles.contextLine, styles.breakPreview, { color: colors.subtleText, opacity: breakPreviewProgress }]} numberOfLines={1}>
                (break)
              </Animated.Text>
            </View>
            <View style={[styles.currentLineBox, { minHeight: reservedLineHeight }]}>
              <Animated.Text
                style={[
                  styles.currentLine,
                  { color: colors.accent, opacity: currentOpacity, fontSize: currentFontSizeY, transform: [{ translateY: currentTranslateY }, { translateX: currentTranslateX }] },
                ]}
              >
                {currentText}
              </Animated.Text>
              {/* Duplicates of whichever neighbor is being dragged toward this box, overlaid on the same spot and invisible at rest - next grows in from a horizontal (skip) drag, previous grows in from a downward (back) drag, since those are the only two gestures that actually hand their spot to this box 1:1. */}
              {nextText && (
                <Animated.Text style={[styles.currentLine, styles.incomingOverlay, { color: colors.accent, opacity: incomingNextOpacity, fontSize: incomingNextFontSize }]} pointerEvents="none">
                  {nextText}
                </Animated.Text>
              )}
              {previousText && (
                <Animated.Text style={[styles.currentLine, styles.incomingOverlay, { color: colors.accent, opacity: incomingPreviousOpacity, fontSize: previousFontSizeY }]} pointerEvents="none">
                  {previousText}
                </Animated.Text>
              )}
            </View>
            {upcomingLines.map((line, i) => (
              <Text
                key={cursor + 1 + i}
                style={[styles.contextLine, { color: colors.subtleText, opacity: Math.max(0.15, 0.6 - i * 0.1) }]}
                numberOfLines={1}
              >
                {line.text || '(break)'}
              </Text>
            ))}
            {tapAreaWidth > 0 && (
              <View style={styles.measureLayer} pointerEvents="none">
                <Text style={[styles.currentLine, { width: tapAreaWidth }]} onLayout={(e: LayoutChangeEvent) => recordLineHeight(currentText, e.nativeEvent.layout.height)}>
                  {currentText}
                </Text>
                {nextText && (
                  <Text style={[styles.currentLine, { width: tapAreaWidth }]} onLayout={(e: LayoutChangeEvent) => recordLineHeight(nextText, e.nativeEvent.layout.height)}>
                    {nextText}
                  </Text>
                )}
                {previousText && (
                  <Text style={[styles.currentLine, { width: tapAreaWidth }]} onLayout={(e: LayoutChangeEvent) => recordLineHeight(previousText, e.nativeEvent.layout.height)}>
                    {previousText}
                  </Text>
                )}
              </View>
            )}
          </>
        )}
      </View>

      {/* Same reusable bar NowPlayingScreen's own seek row uses - lets you
          see and precisely scrub position without leaving this screen, on
          top of the edge zones/keyboard seeking above. Seeking here jumps
          the cursor too (see jumpCursorToPosition), same as any other seek.
          Placed right above the action row (not up under the legend, where
          it used to sit) - that put it far from everything else you'd
          actually reach for with a thumb (the edge zones near the bottom of
          tapArea, this action row itself), and separately it had no visible
          position/duration readout at all up there. */}
      <SeekBar colors={colors} positionSeconds={positionSeconds} durationSeconds={durationSeconds} onSeekTo={seekTo} />
      <View style={styles.seekTimesRow}>
        <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(positionSeconds)}</Text>
        <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(durationSeconds)}</Text>
      </View>

      <View style={styles.actionsRow}>
        <Pressable style={styles.actionButton} onPress={undoPrevious} disabled={saving || cursor === 0}>
          <Icon path={mdiUndo} size={22} color={cursor === 0 ? colors.subtleText : colors.text} />
          <Text style={[styles.actionLabel, { color: colors.subtleText }]}>Back</Text>
        </Pressable>
        <Pressable style={styles.actionButton} onPress={skipLine} disabled={saving || finished}>
          <Icon path={mdiTrashCanOutline} size={22} color={finished ? colors.subtleText : colors.text} />
          <Text style={[styles.actionLabel, { color: colors.subtleText }]}>Skip line</Text>
        </Pressable>
        <Pressable style={styles.actionButton} onPress={insertBreak} disabled={saving || finished}>
          <Icon path={mdiPlaylistPlus} size={22} color={finished ? colors.subtleText : colors.text} />
          <Text style={[styles.actionLabel, { color: colors.subtleText }]}>Insert break</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  progress: {
    fontSize: 13,
    textAlign: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendText: {
    fontSize: 11,
  },
  tooltip: {
    fontSize: 12,
    marginTop: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  /** One of the two edge-of-screen seek zones inside tapArea - see handleEdgeTap/startFastSeek. */
  // Touch target spans the zone's full height (an easy, forgiving thumb
  // target), but the icon itself sits near the bottom instead of
  // vertically centered - centered collided with the upcoming-lines
  // preview text, which also centers in roughly the same spot (confirmed
  // live on Android: the rewind/fast-forward glyph sat right on top of the
  // first preview line, both unreadable).
  edgeZone: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: EDGE_ZONE_WIDTH_PX,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 28,
  },
  edgeZoneLeft: { left: 0 },
  edgeZoneRight: { right: 0 },
  edgeZoneText: {
    fontSize: 13,
    fontWeight: '700',
  },
  tapArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  contextLine: {
    fontSize: 14,
    opacity: 0.6,
    textAlign: 'center',
  },
  currentLine: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  currentLineBox: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  previousSlot: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  /** The "(break)" crossfade target, stacked on previousSlot's real text - see breakPreviewProgress. */
  breakPreview: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  /** A neighbor line's duplicate, stacked on currentLineBox's real text - see incomingNextOpacity/incomingPreviousOpacity. Invisible (opacity 0) at rest, so it's harmless even while its own drag direction isn't active. */
  incomingOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  /** Off-screen twin of the current/next line, same style/width as the real one, just to measure its natural height (see reservedLineHeight) - position:absolute takes it out of tapArea's flex flow entirely, so it never affects the visible layout itself. */
  measureLayer: {
    position: 'absolute',
    opacity: 0,
  },
  /** Base for all four edge reveal bars - see topRevealSize and friends. overflow:'hidden' clips the label while the bar is still too thin to hold it, instead of the text spilling out past a 0-20px strip. */
  revealBar: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  revealBarTop: { top: 0, left: 0, right: 0 },
  revealBarBottom: { bottom: 0, left: 0, right: 0 },
  revealBarLeft: { top: 0, bottom: 0, left: 0 },
  revealBarRight: { top: 0, bottom: 0, right: 0 },
  revealBarText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
  },
  seekTimesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  seekTimeText: {
    fontSize: 12,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 12,
  },
  actionButton: {
    alignItems: 'center',
    gap: 4,
  },
  actionLabel: {
    fontSize: 11,
  },
});

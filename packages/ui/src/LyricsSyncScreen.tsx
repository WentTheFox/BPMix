import type { LyricLine } from '@bpmix/core';
import { mdiChevronUp, mdiClose, mdiPlaylistPlus, mdiTrashCanOutline } from '@mdi/js';
import { useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';

/** Below this, a gesture reads as a tap rather than a swipe in any direction. */
const SWIPE_THRESHOLD_PX = 24;

export interface LyricsSyncScreenProps {
  colors: Colors;
  /** The plain (unsynced) lyric lines to assign timestamps to, in order - typically a ParsedLyrics with synced:false, mapped to its text. */
  lines: string[];
  /** Live playback position, read at the moment of each tap/gesture - this screen never controls playback itself (see its own doc for why), just reads where it already is. */
  positionSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
  onCancel: () => void;
  /** Called once every line has a timestamp. */
  onComplete: (lines: LyricLine[]) => void;
  /** True between onComplete firing and the caller's write actually landing - disables input so a second tap can't double-submit. */
  saving?: boolean;
}

/**
 * Tap-to-advance manual lyrics sync (see CLAUDE.md's lyrics-editor TODO) -
 * opened from LyricsSection's "Sync lyrics manually" button for a track
 * whose assigned .lrc is plain/unsynced. Four gestures on the main area:
 *
 * - tap: record positionSeconds as the current line's timestamp, advance
 * - swipe up: undo the current line's timestamp and go back one (a no-op
 *   on the first line - nowhere to go back to)
 * - swipe left: drop the current line entirely (a section header or
 *   ad-lib that isn't actually its own sung line) without timing it
 * - swipe right: insert a blank timed "break" entry at the current moment
 *   ahead of the current line, for an instrumental gap worth marking -
 *   written out as a plain [mm:ss.xx] tag with no text, a convention
 *   several LRC players already use for exactly this
 *
 * Deliberately has no play/pause control of its own - tap-to-sync only
 * makes sense while the track keeps playing underneath it, so the whole
 * premise is that something already started it before this screen opened.
 * The seek-step buttons are for re-trying a line, not for pausing.
 *
 * Out of scope for this first pass (see CLAUDE.md's remaining lyrics-editor
 * sub-items): the multi-language translation-timing carry-over case, and
 * the separate whole-file time-shift mode.
 */
export function LyricsSyncScreen({ colors, lines, positionSeconds, onSeekTo, onCancel, onComplete, saving }: LyricsSyncScreenProps) {
  const [entries, setEntries] = useState<LyricLine[]>(() => lines.map((text) => ({ timeSeconds: null, text })));
  const [cursor, setCursor] = useState(0);
  // Read inside the PanResponder's release handler via a ref, not the
  // positionSeconds closure captured when the responder was created -
  // PanResponder's handler object is built once (useRef below) and reused
  // across renders, so a plain closure over the prop would see whatever
  // position was current at mount, not at the moment of the actual gesture.
  const positionRef = useRef(positionSeconds);
  positionRef.current = positionSeconds;

  const finished = cursor >= entries.length;

  const recordTimestamp = () => {
    if (finished) return;
    const next = entries.slice();
    next[cursor] = { ...next[cursor]!, timeSeconds: positionRef.current };
    const nextCursor = cursor + 1;
    setEntries(next);
    setCursor(nextCursor);
    if (nextCursor >= next.length) onComplete(next);
  };

  const undoPrevious = () => {
    if (cursor === 0) return;
    const prevCursor = cursor - 1;
    const next = entries.slice();
    next[prevCursor] = { ...next[prevCursor]!, timeSeconds: null };
    setEntries(next);
    setCursor(prevCursor);
  };

  const skipLine = () => {
    if (finished) return;
    const next = entries.slice();
    next.splice(cursor, 1);
    setEntries(next);
    if (cursor >= next.length) onComplete(next);
  };

  const insertBreak = () => {
    if (finished) return;
    const next = entries.slice();
    next.splice(cursor, 0, { timeSeconds: positionRef.current, text: '' });
    setEntries(next);
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

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_event, gesture) => {
        const { dx, dy } = gesture;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX && Math.abs(dy) < SWIPE_THRESHOLD_PX) {
          actionsRef.current.recordTimestamp();
        } else if (Math.abs(dy) >= Math.abs(dx)) {
          if (dy < 0) actionsRef.current.undoPrevious(); // swipe up
          // swipe down is deliberately unmapped
        } else if (dx < 0) {
          actionsRef.current.skipLine(); // swipe left
        } else {
          actionsRef.current.insertBreak(); // swipe right
        }
      },
    }),
  ).current;

  const seekBy = (deltaSeconds: number) => onSeekTo(Math.max(0, positionRef.current + deltaSeconds));

  const previousLine = cursor > 0 ? entries[cursor - 1] : null;
  const currentLine = !finished ? entries[cursor] : null;
  const nextLine = !finished && cursor + 1 < entries.length ? entries[cursor + 1] : null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Pressable onPress={onCancel} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }} disabled={saving}>
          <IconLabel path={mdiClose} text="Cancel" color={colors.text} iconSize={18} textStyle={styles.headerText} />
        </Pressable>
        <Text style={[styles.progress, { color: colors.subtleText }]}>
          {finished ? 'Done' : `Line ${cursor + 1} of ${entries.length}`}
        </Text>
      </View>

      <Text style={[styles.instructions, { color: colors.subtleText }]}>
        Tap to mark this line and move on. Swipe up to undo. Swipe left to skip a line. Swipe right to insert a timing break.
      </Text>

      <View style={styles.seekRow}>
        <Pressable style={styles.seekButton} onPress={() => seekBy(-10)} disabled={saving}>
          <Text style={[styles.seekButtonText, { color: colors.accent }]}>-10s</Text>
        </Pressable>
        <Pressable style={styles.seekButton} onPress={() => seekBy(-5)} disabled={saving}>
          <Text style={[styles.seekButtonText, { color: colors.accent }]}>-5s</Text>
        </Pressable>
        <Pressable style={styles.seekButton} onPress={() => seekBy(5)} disabled={saving}>
          <Text style={[styles.seekButtonText, { color: colors.accent }]}>+5s</Text>
        </Pressable>
        <Pressable style={styles.seekButton} onPress={() => seekBy(10)} disabled={saving}>
          <Text style={[styles.seekButtonText, { color: colors.accent }]}>+10s</Text>
        </Pressable>
      </View>

      <View style={styles.tapArea} {...(saving ? {} : panResponder.panHandlers)}>
        {saving ? (
          <ActivityIndicator color={colors.accent} />
        ) : finished ? (
          <Text style={[styles.currentLine, { color: colors.text }]}>All lines synced</Text>
        ) : (
          <>
            {previousLine && (
              <Text style={[styles.contextLine, { color: colors.subtleText }]} numberOfLines={1}>
                {previousLine.text || '(break)'}
              </Text>
            )}
            <Text style={[styles.currentLine, { color: colors.accent }]}>{currentLine!.text || '(break)'}</Text>
            {nextLine && (
              <Text style={[styles.contextLine, { color: colors.subtleText }]} numberOfLines={1}>
                {nextLine.text || '(break)'}
              </Text>
            )}
          </>
        )}
      </View>

      <View style={styles.actionsRow}>
        <Pressable style={styles.actionButton} onPress={undoPrevious} disabled={saving || cursor === 0}>
          <Icon path={mdiChevronUp} size={22} color={cursor === 0 ? colors.subtleText : colors.text} />
          <Text style={[styles.actionLabel, { color: colors.subtleText }]}>Undo</Text>
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerText: {
    fontSize: 16,
    fontWeight: '600',
  },
  progress: {
    fontSize: 13,
  },
  instructions: {
    fontSize: 12,
    marginTop: 12,
    lineHeight: 17,
  },
  seekRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  seekButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  seekButtonText: {
    fontSize: 13,
    fontWeight: '600',
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

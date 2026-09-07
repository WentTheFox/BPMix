import { scanAllLyricsScopes, type FileAccess, type FileRef, type LibraryStore, type LyricsScope } from '@bpmix/core';
import { mdiSubtitles } from '@mdi/js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native';
import { IconLabel } from './IconLabel';
import { LyricsPickerScreen } from './LyricsPickerScreen';
import type { Colors } from './theme';
import { useAssignedLyrics } from './useAssignedLyrics';
import { invalidateHasLyricsCache } from './useHasLyrics';

export interface LyricsSectionProps {
  colors: Colors;
  fileAccess: FileAccess;
  libraryStore: LibraryStore;
  lyricsScopes: LyricsScope[];
  /** null while nothing is playing - the section renders nothing in that case. */
  trackFileId: string | null;
  /** Drives which synced line is highlighted/scrolled-to - ignored for unsynced lyrics. */
  positionSeconds: number;
  /** Jumps playback to a tapped synced line's timestamp - same callback SeekBar uses. */
  onSeekTo: (positionSeconds: number) => void;
}

interface Row {
  key: string;
  text: string;
  timeSeconds: number | null;
  /** See LyricLine.translation's doc - undefined/null both mean "no translation to show". */
  translation?: string | null;
}

/**
 * The lyrics area of the Now Playing screen: synced lyrics scroll and
 * highlight the current line against playback position, unsynced/plain
 * lyrics just scroll, and a track with nothing assigned shows a placeholder
 * plus a button that opens LyricsPickerScreen to link one manually. Loading
 * (useAssignedLyrics) and manual-assignment (putLyricsAssignment) are both
 * handled internally so callers (NowPlayingScreen, and each app's App.tsx)
 * only need to pass through the same fileAccess/libraryStore/lyricsScopes
 * they already have.
 */
export function LyricsSection({ colors, fileAccess, libraryStore, lyricsScopes, trackFileId, positionSeconds, onSeekTo }: LyricsSectionProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<FileRef[] | null>(null);
  const [currentAssignmentId, setCurrentAssignmentId] = useState<string | null>(null);
  // Set only between tapping a candidate/Remove in the picker and the write
  // actually landing - putLyricsAssignment (a storage write, not instant
  // everywhere: SQLite on Android, IndexedDB on web) shouldn't leave the
  // picker looking idle/tappable-again in that gap.
  const [assigning, setAssigning] = useState(false);

  const lyrics = useAssignedLyrics(fileAccess, libraryStore, lyricsScopes, trackFileId, reloadToken);
  // Memoized on `lyrics` itself (stable across re-renders until it actually
  // reloads) rather than rebuilt inline in the JSX below - LyricsSection
  // re-renders on every positionSeconds tick (several times a second), and a
  // fresh array from a fresh .map() each time gave LyricsList's scroll-to-
  // current-line effect (which depends on this array) an unstable
  // dependency, re-firing - and re-animating toward the same target - on
  // every tick instead of only when the current line actually changes.
  // Confirmed on-device as the cause of a choppy scroll that could settle on
  // the wrong (top-pinned) position if a screenshot/observation caught it
  // mid-animation.
  const rows = useMemo<Row[]>(
    () => (lyrics ? lyrics.lines.map((line, i) => ({ key: String(i), text: line.text, timeSeconds: line.timeSeconds, translation: line.translation })) : []),
    [lyrics],
  );

  useEffect(() => {
    if (!pickerOpen || !trackFileId) return;
    let cancelled = false;
    setCandidates(null);
    Promise.all([scanAllLyricsScopes(fileAccess, lyricsScopes), libraryStore.getLyricsAssignment(trackFileId)]).then(([files, assignment]) => {
      if (cancelled) return;
      setCandidates(files);
      setCurrentAssignmentId(assignment);
    });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, fileAccess, libraryStore, lyricsScopes, trackFileId]);

  const assign = (lrcFileId: string | null) => {
    if (!trackFileId || assigning) return;
    setAssigning(true);
    libraryStore.putLyricsAssignment(trackFileId, lrcFileId).then(() => {
      invalidateHasLyricsCache(trackFileId);
      setAssigning(false);
      setPickerOpen(false);
      setReloadToken((t) => t + 1);
    });
  };

  if (!trackFileId) return null;

  if (pickerOpen) {
    return (
      <View style={styles.container}>
        <LyricsPickerScreen
          colors={colors}
          candidates={candidates}
          currentFileId={currentAssignmentId}
          saving={assigning}
          onSelect={assign}
          onClear={() => assign(null)}
          onCancel={() => setPickerOpen(false)}
        />
      </View>
    );
  }

  if (lyrics === undefined) {
    return (
      <View style={[styles.container, styles.placeholderContainer]}>
        <ActivityIndicator color={colors.subtleText} />
      </View>
    );
  }

  if (lyrics === null) {
    return (
      <View style={[styles.container, styles.placeholderContainer]}>
        <Text style={[styles.placeholderText, { color: colors.subtleText }]}>Lyrics are not available for this song.</Text>
        <Pressable onPress={() => setPickerOpen(true)}>
          <IconLabel path={mdiSubtitles} text="Link a lyrics file" color={colors.accent} iconSize={16} textStyle={styles.linkText} />
        </Pressable>
      </View>
    );
  }

  return (
    <LyricsList
      colors={colors}
      rows={rows}
      synced={lyrics.synced}
      positionSeconds={positionSeconds}
      onEditPress={() => setPickerOpen(true)}
      onSeekTo={onSeekTo}
    />
  );
}

// styles.line's lineHeight (24) + its top+bottom paddingVertical (6+6) - kept
// as one constant so getItemLayout below can't silently drift out of sync
// with the actual rendered row height.
const LINE_HEIGHT = 36;
// styles.translationLine's lineHeight (18) + marginTop (-2) + paddingBottom
// (4) - the extra height a row with a translation adds on top of LINE_HEIGHT.
// Rows were previously all treated as a uniform LINE_HEIGHT in getItemLayout,
// which drifted further from the real cumulative height with every
// translation row above the current line - confirmed on-device as the root
// cause of the current line scrolling to entirely the wrong position (it
// converged exactly to what the (wrong) uniform-height math predicted).
const TRANSLATION_ROW_EXTRA = 18 - 2 + 4;

function rowHeight(row: Row): number {
  return LINE_HEIGHT + (row.translation ? TRANSLATION_ROW_EXTRA : 0);
}

interface LyricsListProps {
  colors: Colors;
  rows: Row[];
  synced: boolean;
  positionSeconds: number;
  onEditPress: () => void;
  onSeekTo: (positionSeconds: number) => void;
}

/**
 * How long to hold off resuming auto-scroll after the user's own scroll
 * settles - long enough to read a line and tap it before the current-line
 * tracking yanks the list back, without leaving it stuck if they were just
 * glancing ahead.
 */
const AUTO_SCROLL_RESUME_DELAY_MS = 3000;

/** Past lines fade to this flat opacity (already sung, de-emphasized but still legible for reference). */
const PAST_LINE_OPACITY = 0.35;
/** Upcoming lines fade progressively further from the current line, down to this floor. */
const MIN_UPCOMING_LINE_OPACITY = 0.3;
const UPCOMING_LINE_FADE_PER_LINE = 0.15;
/** A translation line is always this fraction of its own native line's opacity - dimmer at every fade state (current, past, or upcoming), not just when it happens to be the current line, so it reads as secondary to its native line throughout, not just relative to other rows. */
const TRANSLATION_OPACITY_FACTOR = 0.75;

function lineOpacity(index: number, currentIndex: number | null): number {
  if (currentIndex === null || index === currentIndex) return 1;
  if (index < currentIndex) return PAST_LINE_OPACITY;
  const linesAhead = index - currentIndex;
  return Math.max(MIN_UPCOMING_LINE_OPACITY, 1 - linesAhead * UPCOMING_LINE_FADE_PER_LINE);
}

function LyricsList({ colors, rows, synced, positionSeconds, onEditPress, onSeekTo }: LyricsListProps) {
  const listRef = useRef<FlatList<Row>>(null);
  const currentIndex = useMemo(() => (synced ? currentLyricsLineIndex(rows, positionSeconds) : null), [rows, synced, positionSeconds]);

  // Suppresses the auto-scroll-to-current-line effect while (and briefly
  // after) the user drags the list themselves - without this, scrubbing up
  // to find and tap an earlier/later line gets fought by the effect
  // snapping it straight back to the actively-playing line on every
  // position tick.
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const resumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resumeTimeoutRef.current) clearTimeout(resumeTimeoutRef.current);
  }, []);
  const pauseAutoScroll = () => {
    if (resumeTimeoutRef.current) clearTimeout(resumeTimeoutRef.current);
    setAutoScrollPaused(true);
  };
  const scheduleAutoScrollResume = () => {
    if (resumeTimeoutRef.current) clearTimeout(resumeTimeoutRef.current);
    resumeTimeoutRef.current = setTimeout(() => setAutoScrollPaused(false), AUTO_SCROLL_RESUME_DELAY_MS);
  };

  // Tracks the last index actually scrolled to, so a jump of several lines
  // at once (opening Now Playing mid-track, or seeking) snaps instantly
  // instead of animating - RN's scrollToIndex animation visibly overshoots
  // and corrects itself over long distances (confirmed on-device), and an
  // instant jump doesn't need to be smooth in the first place. Ordinary
  // playback advancing one line at a time still animates.
  const lastScrolledIndexRef = useRef<number | null>(null);
  const SMALL_JUMP_LINE_COUNT = 2;

  // scrollToIndex's own `viewPosition` centering never actually centered
  // correctly on-device, however this was approached (a single
  // requestAnimationFrame delay before the first call; waiting for
  // FlatList's own onLayout to fire once; tracking the real reported
  // height and re-running on every change) - it consistently pinned the
  // current line at the very top of the list instead. Root cause (found via
  // on-device logcat instrumentation): scrollToIndex/scrollToOffset both
  // just move the real underlying ScrollView to a raw pixel offset, which
  // can only reach as far as content has actually been rendered/measured -
  // on a fresh mount, virtualization hasn't laid out anywhere near a current
  // line deep into the song yet, so the requested offset silently clamps
  // far short of the target and the line lands pinned near the top instead
  // of centered, no matter how correct the offset math itself is (confirmed
  // by logging the actual computed offset alongside the wrong on-screen
  // result). initialScrollIndex (below, on the FlatList) fixes the mount
  // case by having FlatList pre-render its initial window starting at that
  // index via getItemLayout, before anything tries to scroll - this
  // subsequent effect then only has to nudge that already-rendered
  // position to centered, which the ScrollView can actually satisfy.
  // Later, this computes the centered scroll offset directly with
  // scrollToOffset: itemOffset (from the same rowOffsets/rowHeight
  // arithmetic getItemLayout already uses) minus half the list's own
  // measured height, plus half the current row's height to center ON the
  // line rather than its top edge. Still only usable once layoutHeight is a
  // real measured value (see onLayout below) - a track opened before that
  // first layout simply doesn't scroll yet, rather than scrolling against
  // a bogus height.
  const [layoutHeight, setLayoutHeight] = useState(0);

  // Cumulative pixel offset of each row's top edge, computed from each row's
  // real (translation-aware) height rather than assuming LINE_HEIGHT for
  // every row - see rowHeight/TRANSLATION_ROW_EXTRA above.
  const rowOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const row of rows) {
      offsets.push(acc);
      acc += rowHeight(row);
    }
    return offsets;
  }, [rows]);

  useEffect(() => {
    if (currentIndex === null || autoScrollPaused || layoutHeight <= 0) return;
    const previous = lastScrolledIndexRef.current;
    const isSmallJump = previous !== null && Math.abs(currentIndex - previous) <= SMALL_JUMP_LINE_COUNT;
    lastScrolledIndexRef.current = currentIndex;
    const itemOffset = rowOffsets[currentIndex]!;
    const currentHeight = rowHeight(rows[currentIndex]!);
    const targetOffset = Math.max(0, itemOffset - layoutHeight / 2 + currentHeight / 2);
    listRef.current?.scrollToOffset({ offset: targetOffset, animated: isSmallJump });
  }, [currentIndex, autoScrollPaused, layoutHeight, rowOffsets, rows]);

  return (
    <View style={styles.container}>
      <View style={styles.editRow}>
        <Pressable onPress={onEditPress}>
          <Text style={[styles.editLink, { color: colors.accent }]}>Change lyrics file</Text>
        </Pressable>
      </View>
      {!synced && (
        <View style={styles.unsyncedRow}>
          <Text style={[styles.unsyncedNote, { color: colors.subtleText }]}>Not synced to playback</Text>
          {/* Disabled placeholder - manual line-by-line syncing is a planned feature (see CLAUDE.md's TODOs), not implemented yet. */}
          <Pressable disabled style={styles.syncButton}>
            <Text style={[styles.syncButtonText, { color: colors.subtleText }]}>Sync lyrics manually</Text>
          </Pressable>
        </View>
      )}
      <FlatList
        ref={listRef}
        style={styles.list}
        data={rows}
        keyExtractor={(row) => row.key}
        // Only consulted once, on the very first render (RN's documented
        // contract for this prop) - lets FlatList pre-render its initial
        // window starting at the current line via getItemLayout, before the
        // scroll-to-center effect below ever calls scrollToOffset. Without
        // this, that first scrollToOffset call targets a raw pixel offset
        // deep into unrendered content that the real ScrollView can't
        // physically scroll to yet, and silently clamps far short of it -
        // see the effect's comment for how this was root-caused.
        initialScrollIndex={currentIndex ?? undefined}
        onLayout={(event) => setLayoutHeight(event.nativeEvent.layout.height)}
        // A synchronous height/offset estimate (from rowOffsets/rowHeight,
        // translation-aware - see above) is what makes scrollToIndex/
        // scrollToOffset work correctly from the very first call, before
        // anything has actually been measured - without it, FlatList falls
        // back to onScrollToIndexFailed's own estimate, which can overshoot
        // past the real content into blank space. A line that wraps to two
        // visual lines just makes the scroll position for lines after it
        // slightly imprecise, never broken.
        getItemLayout={(_, index) => ({ length: rowHeight(rows[index]!), offset: rowOffsets[index]!, index })}
        onScrollBeginDrag={pauseAutoScroll}
        onMomentumScrollEnd={scheduleAutoScrollResume}
        // Hidden during the frequent auto-scroll-to-current-line jumps
        // (every position tick advancing the current line re-triggers a
        // scroll, which was making the indicator flicker in and out
        // constantly) - reusing autoScrollPaused rather than new state
        // since it's already exactly "the user is actively scrolling this
        // list themselves right now" (see pauseAutoScroll/
        // scheduleAutoScrollResume above), the same moment the indicator
        // should actually be useful.
        showsVerticalScrollIndicator={autoScrollPaused}
        // FlatList only re-renders already-mounted rows when `data` or
        // `extraData` changes - currentIndex is closed over inside
        // renderItem instead (see TrackList's identical note), so without
        // this, a line already on screen never picked up the
        // highlight/fade as playback position advanced past it - confirmed
        // on-device via pixel sampling (every line stayed plain gray, no
        // accent color, no matter how far into the track).
        extraData={currentIndex}
        renderItem={({ item, index }: ListRenderItemInfo<Row>) => {
          const isCurrent = synced && index === currentIndex;
          const opacity = lineOpacity(index, synced ? currentIndex : null);
          const content = (
            <View>
              <Text
                style={[styles.line, { color: colors.subtleText, opacity }, isCurrent && [styles.lineActive, { color: colors.accent }]]}
              >
                {item.text}
              </Text>
              {item.translation && (
                <Text
                  style={[
                    styles.translationLine,
                    // Always TRANSLATION_OPACITY_FACTOR of the native
                    // line's own opacity (not just a flat translation
                    // style) - a translation line stays visibly dimmer
                    // than its native line at every fade state (current,
                    // past, or upcoming), not only when it happens to be
                    // the current line.
                    { color: colors.subtleText, opacity: opacity * TRANSLATION_OPACITY_FACTOR },
                    // Highlighted like the main line so it doesn't read as
                    // just another dim row once its native line is
                    // current - the opacity factor above still keeps it
                    // visually secondary instead of competing with it.
                    isCurrent && [styles.translationLineActive, { color: colors.accent }],
                  ]}
                >
                  {item.translation}
                </Text>
              )}
            </View>
          );
          // Only synced lines carry a real timestamp to jump to - plain/
          // unsynced lyrics render the same text with no press affordance.
          return item.timeSeconds !== null ? <Pressable onPress={() => onSeekTo(item.timeSeconds!)}>{content}</Pressable> : content;
        }}
      />
    </View>
  );
}

/**
 * Finds the last line whose timestamp has passed - lines are sorted by
 * timeSeconds (parseLrc's contract), so this is a simple linear scan; lyric
 * files are short enough (a few hundred lines at most) that this doesn't
 * need to be a binary search.
 */
export function currentLyricsLineIndex(rows: Row[], positionSeconds: number): number | null {
  let result: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!.timeSeconds;
    if (t !== null && t <= positionSeconds) result = i;
  }
  return result;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    marginTop: 16,
  },
  placeholderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  placeholderText: {
    fontSize: 14,
    textAlign: 'center',
  },
  linkText: {
    fontSize: 14,
    fontWeight: '600',
  },
  editRow: {
    alignItems: 'flex-end',
    marginBottom: 6,
  },
  editLink: {
    fontSize: 12,
    fontWeight: '600',
  },
  unsyncedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  unsyncedNote: {
    fontSize: 12,
    opacity: 0.7,
  },
  syncButton: {
    opacity: 0.4,
  },
  syncButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
  line: {
    fontSize: 16,
    lineHeight: 24,
    paddingVertical: 6,
    textAlign: 'center',
  },
  lineActive: {
    fontSize: 18,
    fontWeight: '700',
  },
  translationLine: {
    fontSize: 13,
    // Explicit (rather than left to the font's natural line height) so
    // TRANSLATION_ROW_EXTRA above can assume this exact value for its
    // getItemLayout/scroll-offset math.
    lineHeight: 18,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: -2,
    paddingBottom: 4,
  },
  translationLineActive: {
    fontSize: 14,
    fontWeight: '600',
    // No opacity override here - TRANSLATION_OPACITY_FACTOR above already
    // handles it (for the current line, base opacity is 1, so this ends up
    // at exactly TRANSLATION_OPACITY_FACTOR).
  },
});

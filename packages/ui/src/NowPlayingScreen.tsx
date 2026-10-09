import type { FileAccess, LibraryStore, LyricsScope } from '@bpmix/core';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BackButton } from './BackButton';
import { CrossfadeArt } from './CrossfadeArt';
import { HeaderRow } from './HeaderRow';
import { LoadingBar } from './LoadingBar';
import { LyricsSection } from './LyricsSection';
import { MarqueeText } from './MarqueeText';
import { SeekBar } from './SeekBar';
import type { Colors } from './theme';

// Bumped up from the old two-disc layout's 130 - a single disc has the
// whole row's width to itself now, so there's no reason to keep it sized
// for sharing space with a second one.
const ART_SIZE = 190;

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface NowPlayingScreenProps {
  colors: Colors;
  /** Omitted for a docked pane (medium/wide viewport tiers - see MultiPaneLayout) rather than a full-screen overlay: there's nothing to "close" when this is permanently visible alongside the library/playlist pane, so the back button is replaced with a plain, non-interactive "Now Playing" label instead. */
  onClose?: () => void;
  /** Already-formatted title text (or a bare fileId fallback) - callers own formatTrackTitle/useTrackMetadata, this just renders the result. */
  title: string;
  upNextTitle?: string | null;
  /**
   * Which track's lyrics to show - since positionSeconds below already
   * switches to the INCOMING track's timeline as soon as a crossfade
   * starts (see each app's displayPositionSeconds), this must switch with
   * it. Feeding LyricsSection the outgoing track's identity alongside the
   * incoming track's position looked up lines against the wrong (usually
   * longer, already-past) song's timestamps - confirmed on-device as old
   * lyrics visibly jumping back and re-scrolling mid-crossfade. Callers
   * should compute this the same way as displayPositionSeconds: the
   * incoming track's key once a crossfade is in flight, the outgoing/
   * current one otherwise.
   */
  lyricsTrackKey: string | null;
  /** Settings.lyricsEnabled - when false, the lyrics panel isn't rendered at all (skipping its fetch too), freeing up the vertical space below the seek bar for users who don't use lyrics. */
  lyricsEnabled: boolean;
  currentArtUri: string | null;
  currentGain: number;
  currentProgress: number;
  /** See CrossfadeArtProps.currentTurnsPerSecond's doc. Defaults to 0 (frozen). */
  currentTurnsPerSecond?: number;
  /** See CrossfadeArtProps.nextArtUri's doc. Defaults to null (nothing crossfading in). */
  nextArtUri?: string | null;
  /** See CrossfadeArtProps.nextGain's doc. Defaults to 0. */
  nextGain?: number;
  isLoading: boolean;
  positionSeconds: number;
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
  /** The primary transport row(s) (including the volume button - see VolumeButton) - genuinely different between mobile (icon buttons flanked by loop/shuffle) and web (adds ±10s seek buttons, loop/shuffle on their own row), so left as a slot rather than forced into one shape. */
  controls: ReactNode;
  fileAccess: FileAccess;
  libraryStore: LibraryStore;
  lyricsScopes: LyricsScope[];
  /** Rendered right-aligned in the same row as the back button - the NotificationBell, so it sits inline rather than floating over content below it. */
  headerRight?: ReactNode;
}

/**
 * The full-screen "now playing" view, opened by tapping MiniPlayerBar's
 * art/title area - everything that used to live in the always-visible
 * inline NowPlayingBar (CrossfadeArt, seek bar, transport controls, volume)
 * now lives here instead, reachable on demand rather than permanently
 * taking up space on the library/playlist screens. See CLAUDE.md's UI/UX
 * TODO this replaces.
 */
export function NowPlayingScreen({
  colors,
  onClose,
  title,
  upNextTitle,
  lyricsTrackKey,
  lyricsEnabled,
  currentArtUri,
  currentGain,
  currentProgress,
  currentTurnsPerSecond = 0,
  nextArtUri = null,
  nextGain = 0,
  isLoading,
  positionSeconds,
  durationSeconds,
  onSeekTo,
  controls,
  fileAccess,
  libraryStore,
  lyricsScopes,
  headerRight,
}: NowPlayingScreenProps) {
  // Live position while dragging the seek bar, mirrored here so the disc's
  // rotation and the position text can both track the drag in real time -
  // the real seek (onSeekTo) stays debounced (see SeekBar's own doc), this
  // is purely visual and updates on every touch-move tick.
  const [previewPositionSeconds, setPreviewPositionSeconds] = useState<number | null>(null);
  const displayPositionSeconds = previewPositionSeconds ?? positionSeconds;
  const displayCurrentProgress = previewPositionSeconds != null && durationSeconds > 0 ? previewPositionSeconds / durationSeconds : currentProgress;
  // True while LyricsSection's manual sync screen is open - hides the disc/
  // title/seek bar block (and this screen's own header, redundant with the
  // sync screen's own Cancel) so it can use the full screen instead of being
  // squeezed into whatever space was left below the disc. See
  // LyricsSection.onSyncActiveChange's own doc.
  const [lyricsSyncActive, setLyricsSyncActive] = useState(false);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {!lyricsSyncActive && (
        <HeaderRow
          left={
            onClose ? (
              <BackButton text="Now Playing" color={colors.text} onPress={onClose} />
            ) : (
              <Text style={[styles.dockedTitle, { color: colors.text }]}>Now Playing</Text>
            )
          }
          right={headerRight}
        />
      )}
      <View style={styles.content}>
        {!lyricsSyncActive && (
          <View>
            <MarqueeText text={title} style={[styles.nowPlayingName, { color: colors.text }]} />
            {upNextTitle && (
              <View style={styles.upNext}>
                <Text style={[styles.upNextText, { color: colors.subtleText }]} numberOfLines={1}>
                  Up next: {upNextTitle}
                </Text>
              </View>
            )}
            <View style={styles.artRow}>
              <CrossfadeArt
                colors={colors}
                currentArtUri={currentArtUri}
                currentGain={currentGain}
                currentProgress={displayCurrentProgress}
                currentTurnsPerSecond={currentTurnsPerSecond}
                currentSeeking={previewPositionSeconds != null}
                nextArtUri={nextArtUri}
                nextGain={nextGain}
                size={ART_SIZE}
              />
            </View>
            {isLoading ? (
              <LoadingBar colors={colors} />
            ) : (
              <SeekBar
                colors={colors}
                positionSeconds={positionSeconds}
                durationSeconds={durationSeconds}
                onSeekTo={onSeekTo}
                onPreview={setPreviewPositionSeconds}
              />
            )}
            <View style={styles.seekTimesRow}>
              <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(displayPositionSeconds)}</Text>
              <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(durationSeconds)}</Text>
            </View>
          </View>
        )}
        {lyricsEnabled && (
          // styles.lyricsWrapper (flex:1, minHeight:0 - unconditional, not
          // just while syncing) is what actually lets LyricsSection's own
          // flex:1 participate in `content`'s flex layout at all - without
          // it this wrapper fell back to a default auto-sized block (no
          // flex/minHeight of its own), so LyricsSection grew to its full
          // unclipped lyric-list height instead of being capped to
          // whatever space was left after the disc/seek bar block and the
          // footer controls, pushing the controls off the bottom of the
          // pane/viewport with nothing able to scroll to them - the actual
          // root cause behind the minHeight:0 fixes elsewhere in this file
          // and in LyricsSection.tsx (necessary, but not sufficient on
          // their own without this). fullScreenLyrics layers its own
          // further styling on top only while lyricsSyncActive.
          <View style={[styles.lyricsWrapper, lyricsSyncActive && styles.fullScreenLyrics]}>
            <LyricsSection
              colors={colors}
              fileAccess={fileAccess}
              libraryStore={libraryStore}
              lyricsScopes={lyricsScopes}
              trackFileId={lyricsTrackKey}
              positionSeconds={displayPositionSeconds}
              onSeekTo={onSeekTo}
              onSyncActiveChange={setLyricsSyncActive}
            />
          </View>
        )}
        <View style={styles.footer}>{controls}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // minHeight: 0 here and on `content`/`fullScreenLyrics` below is a no-op
  // on native (Yoga already lets a flex item shrink below its content
  // size) but required on web: react-native-web compiles a View straight
  // to CSS flexbox, whose spec default is min-height:auto on a flex item -
  // it refuses to shrink below its content's natural height unless told
  // otherwise. Without this, LyricsSection's tall lyric list (itself
  // flex:1, same reasoning - see its own container/list styles) pushed
  // this screen's height past its allotted pane/viewport instead of
  // clipping to it, shoving the transport controls in NowPlayingScreen's
  // footer (pinned to the bottom via content's justifyContent:
  // 'space-between') out of view with no scrollbar able to reach them -
  // confirmed live on the medium/wide docked pane with a long-lyrics track.
  container: {
    flex: 1,
    minHeight: 0,
  },
  // Always applied (not just while syncing) - see the lyricsEnabled block's
  // own comment for why this exact wrapper, unconditionally sized, is what
  // actually fixes the controls-pushed-off-screen bug.
  lyricsWrapper: {
    flex: 1,
    minHeight: 0,
  },
  // Layered on top of lyricsWrapper only while lyricsSyncActive -
  // LyricsSection has no intrinsic height preference of its own
  // (content's justifyContent:'space-between' otherwise just sizes it to
  // its content when nothing else claims the space), so this is what
  // actually lets the sync screen claim the space the disc/seek bar block
  // would have used.
  fullScreenLyrics: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  artRow: {
    alignItems: 'center',
    marginVertical: 24,
  },
  upNext: {
    marginTop: 8,
  },
  upNextText: {
    fontSize: 13,
  },
  nowPlayingName: {
    fontSize: 22,
    fontWeight: '700',
  },
  // Matches BackButton's own text size/weight (18/600) so a docked pane's
  // header reads the same as an overlay's, just without the arrow/tap target.
  dockedTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  seekTimesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  seekTimeText: {
    fontSize: 12,
  },
  // Pushed to the bottom of `content` (flex:1, space-between) rather than
  // flowing right after the seek bar, so the transport controls land at a
  // consistent, reachable spot regardless of how much space the art/title
  // block above ends up taking.
  footer: {
    paddingBottom: 24,
  },
});

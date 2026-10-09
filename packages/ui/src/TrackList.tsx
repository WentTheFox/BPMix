import { trackDisplayName, type LibraryStore, type TrackRecord } from '@bpmix/core';
import { mdiClose, mdiPencilOutline, mdiSwapVertical, mdiTrashCanOutline } from '@mdi/js';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ConfirmDialog } from './ConfirmDialog';
import { IconLabel } from './IconLabel';
import type { Colors } from './theme';
import { TRACK_ROW_HEIGHT, TrackRow } from './TrackRow';

export interface TrackListProps {
  trackFileIds: string[];
  tracksById: Map<string, TrackRecord>;
  currentFileId: string | null;
  isPlaying: boolean;
  /** See TrackRow.isLoading's doc - passed straight through. */
  isLoading?: boolean;
  textColor: string;
  /** Only needed for the search box's border/placeholder - see the note above the TextInput below. */
  colors: Colors;
  onPressTrack: (track: TrackRecord) => void;
  libraryStore: LibraryStore;
  /** How many rows to render up front - tunable per app since mobile/web have historically used different values here, not because the list itself differs. */
  initialNumToRender?: number;
  /** fileIds whose most recent playback attempt failed to decode - see TrackRow.isMissing's doc. Omitted entirely (not just empty) by a caller that doesn't track this. */
  missingFileIds?: Set<string>;
  /** See TrackRow.onAddToPlaylist's doc - passed straight through, omitted entirely by every caller except the Unplaylisted automatic view. */
  onAddToPlaylist?: (track: TrackRecord) => void;
  /**
   * Enables reorder mode (long-press a row, or the "Reorder" toolbar button)
   * for a real, file-backed playlist - moves the selected track(s) to just
   * before/after an anchor track via movePlaylistTracks. Omitted entirely
   * for a virtual playlist (Unplaylisted, Now Playing), which has no .m3u8
   * to persist to - same convention as onAddToPlaylist being omitted
   * elsewhere. Must catch and report its own errors (e.g. via the caller's
   * notificationCenter) - TrackList only awaits it to know when to close
   * its confirm dialog and exit reorder mode, on success or failure alike.
   */
  onMoveTracks?: (movingFileIds: string[], anchorFileId: string, position: 'before' | 'after') => Promise<void>;
  /** Removes the given track(s) from the playlist via removePlaylistTracks - same omission convention and error-handling contract as onMoveTracks. */
  onRemoveTracks?: (fileIds: string[]) => Promise<void>;
  /** Opens a raw-text editor for the playlist's own .m3u8 file (see EditPlaylistFileScreen) - same omission convention as onMoveTracks/onRemoveTracks. Rendered as a second toolbar button next to "Reorder". */
  onEditRaw?: () => void;
}

/**
 * The playlist screen's track list - a virtualized FlatList of TrackRow,
 * with getItemLayout wired to TrackRow's fixed height (TRACK_ROW_HEIGHT)
 * so a long list can compute any row's scroll position by arithmetic
 * instead of measuring as it goes (the playlist's length - and so every
 * row's position - is known upfront). Shared between mobile and web
 * (identical there beyond initialNumToRender, so it lives here rather than
 * being duplicated per-app - see CLAUDE.md's note on why that's worth
 * doing proactively).
 *
 * Includes its own filename search box above the list - filters by
 * trackDisplayName (the filename) rather than scanned title/artist
 * metadata, since that's the one thing synchronously available for every
 * row here without waiting on the background metadata scan (see
 * scanLibraryMetadata) or fetching it in bulk just for search. Good enough
 * to find a track in a large playlist by name; doesn't match on artist
 * unless the filename happens to include it.
 */
export function TrackList({
  trackFileIds,
  tracksById,
  currentFileId,
  isPlaying,
  isLoading,
  textColor,
  colors,
  onPressTrack,
  libraryStore,
  initialNumToRender = 20,
  missingFileIds,
  onAddToPlaylist,
  onMoveTracks,
  onRemoveTracks,
  onEditRaw,
}: TrackListProps): React.JSX.Element {
  const [query, setQuery] = useState('');

  // Reorder mode's own state - see the toolbar/ConfirmDialog rendering
  // below for how these drive the UI. Entirely inert (never set) unless
  // onMoveTracks/onRemoveTracks is actually given - a virtual playlist
  // screen never shows any of this.
  const [reorderModeActive, setReorderModeActive] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [pendingMove, setPendingMove] = useState<{ anchor: TrackRecord; position: 'before' | 'after' } | null>(null);
  const [pendingRemove, setPendingRemove] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const exitReorderMode = useCallback(() => {
    setReorderModeActive(false);
    setSelectedFileIds(new Set());
  }, []);

  const confirmMove = async () => {
    if (!pendingMove || !onMoveTracks || isCommitting) return;
    setIsCommitting(true);
    try {
      await onMoveTracks([...selectedFileIds], pendingMove.anchor.fileId, pendingMove.position);
    } finally {
      setIsCommitting(false);
      setPendingMove(null);
      exitReorderMode();
    }
  };

  const confirmRemove = async () => {
    if (!onRemoveTracks || isCommitting) return;
    setIsCommitting(true);
    try {
      await onRemoveTracks([...selectedFileIds]);
    } finally {
      setIsCommitting(false);
      setPendingRemove(false);
      exitReorderMode();
    }
  };

  const filteredFileIds = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return trackFileIds;
    return trackFileIds.filter((fileId) => {
      const track = tracksById.get(fileId);
      return !!track && trackDisplayName(track).toLowerCase().includes(needle);
    });
  }, [trackFileIds, tracksById, query]);

  // TrackRow is wrapped in memo() specifically so a long list's off-screen/
  // unchanged rows don't re-render on every ~200ms playback poll tick (see
  // its own doc) - an inline renderItem here would defeat that entirely,
  // since FlatList treats a changed renderItem identity as a reason to
  // re-render every currently-mounted row, not just this list's own JSX.
  const renderItem = useCallback(
    ({ item: fileId }: { item: string }) => {
      const track = tracksById.get(fileId);
      if (!track) return null;
      return (
        <TrackRow
          track={track}
          isCurrent={currentFileId === fileId}
          isPlaying={isPlaying}
          isLoading={isLoading}
          textColor={textColor}
          colors={colors}
          onPress={onPressTrack}
          libraryStore={libraryStore}
          isMissing={track.missing || missingFileIds?.has(fileId)}
          onAddToPlaylist={onAddToPlaylist}
          reorderMode={reorderModeActive}
          isSelected={selectedFileIds.has(fileId)}
          // Only wired while not already in reorder mode - a long-press
          // mid-reorder would otherwise re-seed the selection down to just
          // this one track, clobbering whatever else was already selected.
          onLongPress={!reorderModeActive && (onMoveTracks || onRemoveTracks) ? (t) => { setReorderModeActive(true); setSelectedFileIds(new Set([t.fileId])); } : undefined}
          onToggleSelect={(t) => setSelectedFileIds((prev) => {
            const next = new Set(prev);
            if (next.has(t.fileId)) next.delete(t.fileId);
            else next.add(t.fileId);
            return next;
          })}
          onInsertBefore={(t) => selectedFileIds.size > 0 && setPendingMove({ anchor: t, position: 'before' })}
          onInsertAfter={(t) => selectedFileIds.size > 0 && setPendingMove({ anchor: t, position: 'after' })}
        />
      );
    },
    [
      tracksById,
      currentFileId,
      isPlaying,
      isLoading,
      textColor,
      colors,
      onPressTrack,
      libraryStore,
      missingFileIds,
      onAddToPlaylist,
      reorderModeActive,
      selectedFileIds,
      onMoveTracks,
      onRemoveTracks,
    ],
  );

  const showReorderToolbar = Boolean(onMoveTracks || onRemoveTracks || onEditRaw);

  return (
    <>
      <View style={styles.toolbarRow}>
        <TextInput
          style={[styles.search, { color: textColor, borderColor: colors.subtleText }]}
          placeholder="Search tracks…"
          placeholderTextColor={colors.subtleText}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {showReorderToolbar &&
          (reorderModeActive ? (
            <View style={styles.reorderToolbar}>
              <Text style={[styles.selectedCount, { color: colors.subtleText }]}>{selectedFileIds.size} selected</Text>
              {onRemoveTracks && (
                <Pressable disabled={selectedFileIds.size === 0} onPress={() => setPendingRemove(true)}>
                  <IconLabel path={mdiTrashCanOutline} text="Remove" color={selectedFileIds.size === 0 ? colors.subtleText : '#dc2626'} iconSize={14} />
                </Pressable>
              )}
              <Pressable onPress={exitReorderMode}>
                <IconLabel path={mdiClose} text="Cancel" color={colors.subtleText} iconSize={14} />
              </Pressable>
            </View>
          ) : (
            <View style={styles.reorderToolbar}>
              {(onMoveTracks || onRemoveTracks) && (
                <Pressable onPress={() => setReorderModeActive(true)}>
                  <IconLabel path={mdiSwapVertical} text="Reorder" color={colors.accent} iconSize={14} />
                </Pressable>
              )}
              {onEditRaw && (
                <Pressable onPress={onEditRaw}>
                  <IconLabel path={mdiPencilOutline} text="Edit raw" color={colors.accent} iconSize={14} />
                </Pressable>
              )}
            </View>
          ))}
      </View>
      <FlatList
        style={styles.list}
        data={filteredFileIds}
        keyExtractor={(fileId, index) => `${fileId}-${index}`}
        renderItem={renderItem}
        initialNumToRender={initialNumToRender}
        windowSize={7}
        // FlatList only re-renders already-mounted rows when `data` or
        // `extraData` changes - currentFileId/isPlaying are closed over
        // inside renderItem instead, so without this, a row already on
        // screen wouldn't pick up "now playing"/highlight changes until
        // something else happened to force FlatList to re-render (e.g.
        // scrolling), which read as the highlight lagging a tap by however
        // long that took to happen on its own. reorderModeActive/
        // selectedFileIds need the same treatment for the same reason.
        extraData={[currentFileId, isPlaying, isLoading, missingFileIds, reorderModeActive, selectedFileIds]}
        // Only valid while filteredFileIds is the unfiltered list - a
        // filtered list's rows keep TRACK_ROW_HEIGHT each, but their offsets
        // no longer correspond to `index * TRACK_ROW_HEIGHT` against the
        // full playlist, so this only needs to (and does) hold since it's
        // computed straight from filteredFileIds' own index each time.
        getItemLayout={(_, index) => ({ length: TRACK_ROW_HEIGHT, offset: TRACK_ROW_HEIGHT * index, index })}
      />
      {/* Rendered after FlatList, not before - on this RN/Fabric+web stack a
          later sibling can catch clicks meant for an earlier absolutely-
          positioned overlay despite painting underneath it (see
          ScreenLayer's own doc for the same lesson at the screen level) -
          confirmed live here as a tap landing on the FlatList row behind the
          dialog instead of the dialog's own Confirm/Cancel buttons. */}
      {pendingMove && (
        <ConfirmDialog
          colors={colors}
          title={`Move ${selectedFileIds.size} track${selectedFileIds.size === 1 ? '' : 's'}`}
          message={`Move the selected track${selectedFileIds.size === 1 ? '' : 's'} ${pendingMove.position} "${trackDisplayName(pendingMove.anchor)}"?`}
          confirmLabel="Move"
          onConfirm={() => void confirmMove()}
          onCancel={() => setPendingMove(null)}
        />
      )}
      {pendingRemove && (
        <ConfirmDialog
          colors={colors}
          title={`Remove ${selectedFileIds.size} track${selectedFileIds.size === 1 ? '' : 's'}`}
          message={`Remove the selected track${selectedFileIds.size === 1 ? '' : 's'} from this playlist?`}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingRemove(false)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // Wraps the search box and the reorder/edit-raw toolbar in one row -
  // carries the centering/width/inset styling the search box used to carry
  // on its own, now that it shares the row with the toolbar buttons.
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    // Matches HeaderRow's own horizontal inset (16) and TrackRow's - without
    // this, the search box's border sat flush against the screen edges even
    // though its placeholder text had its own inset padding, reading as
    // inconsistent with every other edge-aligned element on the screen.
    marginHorizontal: 16,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  search: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  reorderToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  selectedCount: {
    fontSize: 13,
  },
  list: {
    flex: 1,
    marginTop: 12,
    width: '100%',
    maxWidth: 480,
  },
});

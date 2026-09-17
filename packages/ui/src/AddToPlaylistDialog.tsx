import type { PlaylistRecord } from '@bpmix/core';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';

export interface AddToPlaylistDialogProps {
  colors: Colors;
  /** Real playlists only - a caller building this from RootWithLibrary should filter out any virtual/automatic ones (see LibraryScreen's own Automatic-section split) before passing them here. */
  playlists: PlaylistRecord[];
  trackLabel: string;
  onSelect: (playlist: PlaylistRecord, position: 'start' | 'end') => Promise<void>;
  onCancel: () => void;
}

/**
 * A ConfirmDialog-shaped picker (same full-screen-backdrop-plus-centered-box
 * treatment, not React Native's own Modal - see ConfirmDialog's doc for why)
 * listing a root's real playlists to add one or more tracks to. Used by the
 * Unplaylisted automatic view's per-row "add to playlist" action - the one
 * place today a track can legitimately be added to an existing playlist
 * rather than only ever appended when a whole new one is created from a
 * folder (see CLAUDE.md's playlist-editor TODO for the rest of that: moving/
 * reordering existing entries is still unimplemented).
 */
export function AddToPlaylistDialog({ colors, playlists, trackLabel, onSelect, onCancel }: AddToPlaylistDialogProps) {
  const [busyPlaylistId, setBusyPlaylistId] = useState<string | null>(null);
  const [position, setPosition] = useState<'start' | 'end'>('end');

  const handleSelect = async (playlist: PlaylistRecord) => {
    if (busyPlaylistId) return;
    setBusyPlaylistId(playlist.id);
    try {
      await onSelect(playlist, position);
    } finally {
      setBusyPlaylistId(null);
    }
  };

  return (
    <>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={[styles.box, { backgroundColor: colors.background, borderColor: colors.accent }]}>
          {/* Fixed heading, never truncated - a long trackLabel used to be
              folded into this same line ('Add "<name>" to…'), so a long
              filename's numberOfLines={1} ellipsis could eat the "to…" part
              itself, leaving a title that looked cut off with no indication
              there was ever a target list below it. */}
          <Text style={[styles.title, { color: colors.text }]}>Add to playlist</Text>
          <Text style={[styles.trackLabel, { color: colors.subtleText }]} numberOfLines={1}>
            {trackLabel}
          </Text>
          {playlists.length === 0 ? (
            <Text style={[styles.empty, { color: colors.subtleText }]}>No playlists yet in this folder - create one from the library screen first.</Text>
          ) : (
            <>
              <View style={styles.positionToggle}>
                {(['start', 'end'] as const).map((option) => {
                  const selected = position === option;
                  return (
                    <Pressable
                      key={option}
                      onPress={() => setPosition(option)}
                      style={[styles.positionOption, { borderColor: colors.accent }, selected && { backgroundColor: colors.accent }]}
                    >
                      <Text style={[styles.positionOptionText, { color: selected ? colors.background : colors.accent }]}>
                        {option === 'start' ? 'Add to start' : 'Add to end'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <ScrollView style={styles.list}>
              {playlists.map((playlist) => (
                <Pressable
                  key={playlist.id}
                  style={styles.row}
                  disabled={busyPlaylistId !== null}
                  onPress={() => void handleSelect(playlist)}
                >
                  <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={1}>
                    {playlist.name}
                  </Text>
                  {busyPlaylistId === playlist.id && <ActivityIndicator size="small" color={colors.accent} />}
                </Pressable>
              ))}
              </ScrollView>
            </>
          )}
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.actionButton}>
              <Text style={[styles.actionText, { color: colors.subtleText }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Matches ConfirmDialog's own backdrop/centerWrap exactly - see its doc
  // for why this isn't StyleSheet.absoluteFill.
  backdrop: {
    position: 'absolute',
    top: -2000,
    bottom: -2000,
    left: -2000,
    right: -2000,
  },
  centerWrap: {
    position: 'absolute',
    top: -2000,
    bottom: -2000,
    left: -2000,
    right: -2000,
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: {
    width: 320,
    maxWidth: '90%',
    maxHeight: '70%',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  trackLabel: {
    fontSize: 13,
    marginTop: 2,
    marginBottom: 12,
  },
  empty: {
    fontSize: 13,
    lineHeight: 18,
  },
  positionToggle: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  positionOption: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  positionOptionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 10,
  },
  rowText: {
    fontSize: 14,
    flexShrink: 1,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  actionButton: {
    paddingVertical: 4,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

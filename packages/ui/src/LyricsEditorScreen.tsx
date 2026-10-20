import type { LyricLine } from '@bpmix/core';
import { mdiCheck, mdiClose } from '@mdi/js';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ConfirmDialog } from './ConfirmDialog';
import { IconLabel } from './IconLabel';
import { LyricsEditScreen } from './LyricsEditScreen';
import { LyricsSyncScreen } from './LyricsSyncScreen';
import type { Colors } from './theme';
import { withAlpha } from './theme';

export interface LyricsEditorScreenProps {
  colors: Colors;
  lines: LyricLine[];
  positionSeconds: number;
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
  onCancel: () => void;
  onComplete: (lines: LyricLine[]) => void;
  /** True between onComplete firing and the caller's write actually landing. */
  saving?: boolean;
}

type EditorMode = 'edit' | 'sync';

/**
 * The single lyrics-timing editor entry point, combining what used to be
 * two separate screens (LyricsEditScreen, LyricsSyncScreen) behind one
 * always-visible Edit/Sync switch, so there's one "Lyrics editor" action
 * for the whole feature instead of three separate links (Sync lyrics
 * manually / Edit timestamps / Resync lyrics) scattered around the lyrics
 * panel. Opens in Edit mode by default - most lines in an already-mostly-
 * timed file just need a small nudge, which Edit mode is built for; Sync
 * mode (tap-to-advance against live playback) is for a file that isn't
 * timed at all yet, or needs a full redo.
 *
 * Edit and Sync are genuinely two views over the same data, not two
 * independent drafts: `entries` lives here, not in either sub-screen, and
 * both are handed it as a controlled prop plus an onEntriesChange callback
 * that writes straight back here. Switching modes mid-pass is just
 * re-rendering a different view over the same array - nothing to discard,
 * no confirmation needed, same as switching tabs on a form. There's also
 * exactly one Cancel/Save header (here, not duplicated in either
 * sub-screen) - Save only actually writes the file (via onComplete), with
 * the same "still untimed lines?" confirmation LyricsEditScreen used to
 * own on its own now living here instead, since it applies regardless of
 * which view you happen to be looking at when you tap it.
 */
export function LyricsEditorScreen({ colors, lines, positionSeconds, durationSeconds, onSeekTo, onCancel, onComplete, saving }: LyricsEditorScreenProps) {
  const [mode, setMode] = useState<EditorMode>('edit');
  const [entries, setEntries] = useState<LyricLine[]>(lines);
  const [confirmingSave, setConfirmingSave] = useState(false);

  const untimedCount = entries.filter((entry) => entry.timeSeconds === null).length;
  // Compared against the original `lines` prop (the real current file state
  // this screen was seeded from), not against whichever mode produced the
  // latest change - a shape change (Sync's skip/insert-break) always trips
  // the length check; an in-place edit (either mode) trips the per-index
  // comparison. A nudge then an undo back to the exact original value
  // correctly reads as "no changes" again either way.
  const hasChanges = entries.length !== lines.length || entries.some((entry, i) => entry.timeSeconds !== lines[i]?.timeSeconds || entry.text !== lines[i]?.text);

  const attemptSave = () => {
    if (saving || !hasChanges) return;
    if (untimedCount > 0) {
      setConfirmingSave(true);
      return;
    }
    onComplete(entries);
  };

  // Sync mode's whole premise is tapping through real lines against live
  // playback - with zero entries it has nothing to advance through, and its
  // own cursor/finished math (cursor 0 >= entries.length 0) reads that as
  // "already done", rendering a nonsensical "All lines synced" for a file
  // that was never even loaded. Disabled rather than hidden, same reasoning
  // as Save being disabled-not-hidden elsewhere in this screen.
  const syncDisabled = entries.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Pressable onPress={onCancel} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }} disabled={saving}>
          <IconLabel path={mdiClose} text="Cancel" color={colors.text} iconSize={18} textStyle={styles.headerText} />
        </Pressable>
        <View style={styles.modeSwitch}>
          {(['edit', 'sync'] as const).map((m) => {
            const disabled = saving || (m === 'sync' && syncDisabled);
            return (
              <Pressable key={m} onPress={() => setMode(m)} disabled={disabled} style={[styles.modeButton, mode === m && { backgroundColor: withAlpha(colors.accent, 0.15) }]}>
                <Text style={[styles.modeButtonText, { color: disabled ? colors.subtleText : mode === m ? colors.accent : colors.subtleText, opacity: disabled ? 0.5 : 1 }]}>
                  {m === 'edit' ? 'Edit' : 'Sync'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable onPress={attemptSave} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }} disabled={saving || !hasChanges}>
          <IconLabel path={mdiCheck} text="Save" color={hasChanges ? colors.accent : colors.subtleText} iconSize={18} textStyle={styles.headerText} />
        </Pressable>
      </View>
      <Text style={[styles.progress, { color: untimedCount > 0 ? colors.accent : colors.subtleText }]}>{untimedCount > 0 ? `${untimedCount} untimed` : 'All lines timed'}</Text>
      {mode === 'edit' ? (
        <LyricsEditScreen colors={colors} entries={entries} onEntriesChange={setEntries} saving={saving} />
      ) : (
        <LyricsSyncScreen
          colors={colors}
          entries={entries}
          onEntriesChange={setEntries}
          positionSeconds={positionSeconds}
          durationSeconds={durationSeconds}
          onSeekTo={onSeekTo}
          saving={saving}
        />
      )}
      {confirmingSave && (
        <ConfirmDialog
          colors={colors}
          title="Save with untimed lines?"
          message={`${untimedCount} line${untimedCount === 1 ? '' : 's'} still ${untimedCount === 1 ? 'has' : 'have'} no timestamp and will be saved as plain, unsynced text.`}
          confirmLabel="Save anyway"
          onConfirm={() => {
            setConfirmingSave(false);
            onComplete(entries);
          }}
          onCancel={() => setConfirmingSave(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
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
    textAlign: 'center',
    marginTop: 4,
  },
  modeSwitch: {
    flexDirection: 'row',
    gap: 4,
  },
  modeButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
  },
  modeButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
});

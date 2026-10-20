import { formatTimestamp, type LyricLine } from '@bpmix/core';
import { mdiAlertCircleOutline, mdiClose, mdiMinus, mdiPlus } from '@mdi/js';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View, type ListRenderItemInfo } from 'react-native';
import { Icon } from './Icon';
import type { Colors } from './theme';

export interface LyricsEditScreenProps {
  colors: Colors;
  /** The shared entries array LyricsEditorScreen owns - this screen only mutates it (via onEntriesChange) through per-line edits/nudges, same source LyricsSyncScreen's tap-to-sync flow reads/writes too, so switching between the two mid-pass never loses or resets anything. */
  entries: LyricLine[];
  onEntriesChange: (entries: LyricLine[]) => void;
  /** True between the caller's Save firing and the write actually landing - disables input so a second edit can't fire mid-write. */
  saving?: boolean;
}

/** Nudge size for the per-row +/- buttons - fine enough for "this line's basically right, just needs a touch-up" without needing to retype the whole timestamp, mirroring lrc.seinopsys.dev's own 100ms step. */
const NUDGE_SECONDS = 0.1;

/** Accepts "mm:ss.xx", "mm:ss", or a bare number of seconds - more lenient than the strict [mm:ss.xx] tag format parseLrc reads, since this is a human typing into a box, not a file being parsed. Empty/unparseable input clears the timestamp (null) rather than erroring - typing over "Not timed" and leaving it blank should "stay not timed", not crash. */
function parseTimeInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const colonMatch = trimmed.match(/^(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)$/);
  if (colonMatch) {
    const seconds = Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const plain = Number(trimmed);
  return Number.isFinite(plain) ? plain : null;
}

/**
 * The dedicated per-line timestamp editor (see CLAUDE.md's lyrics-editor
 * TODO, "a more advanced desktop-only editing mode with a dedicated
 * timestamp input field similar to lrc.seinopsys.dev's Edit mode") -
 * distinct from LyricsSyncScreen's tap-to-advance flow: every line is
 * listed at once, each with its own editable timestamp (tap to type a new
 * one, or nudge it by NUDGE_SECONDS), rather than one line at a time driven
 * by live playback. Despite the "desktop-only" framing in the TODO that
 * named this, there's nothing here that actually requires a keyboard - a
 * touch keyboard types into the same TextInput fine - so it isn't gated to
 * any platform.
 *
 * An untimed line (timeSeconds: null) is flagged inline (a warning icon,
 * accent-colored "Not timed" in place of a real time) - the file this
 * screen was built to fix (see the m3u8 lyrics corruption investigation
 * this session) had exactly this shape, discovered only by chance. The
 * untimed-lines-before-save confirmation now lives in LyricsEditorScreen,
 * which owns the one Cancel/Save header both this view and LyricsSyncScreen
 * share, since there's no "save" action local to this view anymore - it
 * only mutates the shared entries array it's handed.
 */
export function LyricsEditScreen({ colors, entries, onEntriesChange, saving }: LyricsEditScreenProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftText, setDraftText] = useState('');

  const updateEntry = (index: number, timeSeconds: number | null) => {
    const next = entries.slice();
    next[index] = { ...next[index]!, timeSeconds };
    onEntriesChange(next);
  };

  const startEditing = (index: number) => {
    const current = entries[index]!.timeSeconds;
    setDraftText(current === null ? '' : formatTimestamp(current));
    setEditingIndex(index);
  };

  const commitDraft = (index: number) => {
    updateEntry(index, parseTimeInput(draftText));
    setEditingIndex(null);
  };

  const nudge = (index: number, deltaSeconds: number) => {
    const current = entries[index]!.timeSeconds;
    if (current === null) return; // nothing to nudge yet - type a starting value first
    updateEntry(index, Math.max(0, current + deltaSeconds));
  };

  const renderItem = ({ item, index }: ListRenderItemInfo<LyricLine>) => {
    const untimed = item.timeSeconds === null;
    const isEditing = editingIndex === index;
    return (
      <View style={styles.row}>
        <Text style={[styles.lineText, { color: colors.text }]} numberOfLines={2}>
          {item.text || '(break)'}
        </Text>
        <View style={styles.timeControl}>
          {isEditing ? (
            <TextInput
              style={[styles.timeInput, { color: colors.text, borderColor: colors.accent }]}
              value={draftText}
              onChangeText={setDraftText}
              onSubmitEditing={() => commitDraft(index)}
              onBlur={() => commitDraft(index)}
              placeholder="mm:ss.xx"
              placeholderTextColor={colors.subtleText}
              autoFocus
              editable={!saving}
            />
          ) : (
            <Pressable style={styles.timeDisplay} onPress={() => startEditing(index)} disabled={saving}>
              {untimed && <Icon path={mdiAlertCircleOutline} size={14} color={colors.accent} />}
              <Text style={[styles.timeText, { color: untimed ? colors.accent : colors.text }]}>{untimed ? 'Not timed' : formatTimestamp(item.timeSeconds!)}</Text>
            </Pressable>
          )}
          <Pressable style={styles.stepButton} onPress={() => nudge(index, -NUDGE_SECONDS)} disabled={saving || untimed}>
            <Icon path={mdiMinus} size={14} color={untimed ? colors.subtleText : colors.text} />
          </Pressable>
          <Pressable style={styles.stepButton} onPress={() => nudge(index, NUDGE_SECONDS)} disabled={saving || untimed}>
            <Icon path={mdiPlus} size={14} color={untimed ? colors.subtleText : colors.text} />
          </Pressable>
          {!untimed && (
            <Pressable style={styles.stepButton} onPress={() => updateEntry(index, null)} disabled={saving} accessibilityLabel="Clear this line's timestamp">
              <Icon path={mdiClose} size={14} color={colors.subtleText} />
            </Pressable>
          )}
        </View>
      </View>
    );
  };

  return <FlatList data={entries} keyExtractor={(_item, index) => String(index)} renderItem={renderItem} style={styles.list} />;
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.25)',
  },
  lineText: {
    flex: 1,
    fontSize: 14,
  },
  timeControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  timeDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 72,
  },
  timeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  timeInput: {
    minWidth: 72,
    fontSize: 12,
    fontWeight: '600',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  stepButton: {
    padding: 4,
  },
});

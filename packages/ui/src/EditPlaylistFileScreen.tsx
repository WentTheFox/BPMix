import { errorMessage, findPlaylistFile, type FileAccess, type PlaylistRecord } from '@bpmix/core';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BackButton } from './BackButton';
import type { Colors } from './theme';
import { withAlpha } from './theme';

export interface EditPlaylistFileScreenProps {
  colors: Colors;
  fileAccess: FileAccess;
  rootId: string;
  playlist: PlaylistRecord;
  onCancel: () => void;
  /** Called once the edited text is successfully written back - the caller should rescan the root (same convention as every other playlist writer here) and close this screen. */
  onSaved: () => void;
}

/**
 * A raw-text editor for a playlist's own .m3u8 file - deliberately not
 * routed through parseM3u8/formatM3u8 at all, so it can fix or add anything
 * a real .m3u8 might contain that the structured reorder/remove UI (see
 * TrackList's reorder mode) can't represent: an already-malformed line (an
 * addTracksToPlaylist-written entry missing its ./ prefix from before that
 * was fixed - see relativizeM3u8EntryPath), comments, blank lines, vendor
 * #EXT... directives - all of which parseM3u8 silently drops on any
 * structured rewrite. Opened from TrackList's "Edit raw" toolbar button for
 * a real, file-backed playlist.
 */
export function EditPlaylistFileScreen({ colors, fileAccess, rootId, playlist, onCancel, onSaved }: EditPlaylistFileScreenProps) {
  const [text, setText] = useState<string | null>(null);
  const [relativePath, setRelativePath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setLoadError(null);
    (async () => {
      const playlistFile = await findPlaylistFile(fileAccess, rootId, playlist);
      const contents = await fileAccess.readFileText(playlistFile);
      if (cancelled) return;
      setRelativePath(playlistFile.relativePath);
      setText(contents);
    })().catch((err) => {
      if (!cancelled) setLoadError(errorMessage(err));
    });
    return () => {
      cancelled = true;
    };
  }, [fileAccess, rootId, playlist]);

  const handleSave = async () => {
    if (text === null || relativePath === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fileAccess.writeFileText(rootId, relativePath, text);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.headerRow}>
        <BackButton text="Edit raw" color={colors.text} onPress={onCancel} disabled={saving} />
        <Pressable onPress={() => void handleSave()} disabled={saving || text === null} style={styles.saveButton}>
          {saving ? <ActivityIndicator size="small" color={colors.accent} /> : <Text style={[styles.saveText, { color: colors.accent }]}>Save</Text>}
        </Pressable>
      </View>
      <Text style={[styles.playlistLabel, { color: colors.subtleText }]} numberOfLines={1}>
        {playlist.name}
      </Text>
      {loadError ? (
        <Text style={styles.error}>{loadError}</Text>
      ) : text === null ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.subtleText }]}>Loading…</Text>
        </View>
      ) : (
        <TextInput
          style={[styles.editor, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }]}
          value={text}
          onChangeText={setText}
          multiline
          autoCorrect={false}
          autoCapitalize="none"
          editable={!saving}
        />
      )}
      {saveError && <Text style={styles.error}>{saveError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  saveButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  saveText: {
    fontSize: 15,
    fontWeight: '700',
  },
  playlistLabel: {
    fontSize: 13,
    marginTop: 4,
    marginBottom: 12,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  loadingText: {
    fontSize: 14,
  },
  editor: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    marginBottom: 16,
    textAlignVertical: 'top',
  },
  error: {
    color: '#dc2626',
    fontSize: 13,
    marginTop: 8,
  },
});

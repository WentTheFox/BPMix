import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Colors } from './theme';
import { withAlpha } from './theme';

export interface TextPromptDialogProps {
  colors: Colors;
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  /** Called with the trimmed text; never with an empty string. */
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

/** A ConfirmDialog-shaped box asking for one line of text (a playlist's name). Same overlay approach - see ConfirmDialog for why not a Modal. */
export function TextPromptDialog({ colors, title, placeholder, initialValue = '', confirmLabel, onConfirm, onCancel }: TextPromptDialogProps) {
  const [text, setText] = useState(initialValue);
  const trimmed = text.trim();
  const submit = () => {
    if (trimmed) onConfirm(trimmed);
  };
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={[styles.box, { backgroundColor: colors.background, borderColor: colors.accent }]}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <TextInput
            style={[styles.input, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }]}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={colors.subtleText}
            autoFocus
            maxLength={200}
            onSubmitEditing={submit}
            returnKeyType="done"
          />
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.actionButton}>
              <Text style={[styles.actionText, { color: colors.subtleText }]}>Cancel</Text>
            </Pressable>
            <Pressable onPress={submit} disabled={!trimmed} style={styles.actionButton}>
              <Text style={[styles.actionText, styles.confirmText, { color: trimmed ? colors.accent : colors.subtleText }]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: -2000, bottom: -2000, left: -2000, right: -2000 },
  centerWrap: { position: 'absolute', top: -2000, bottom: -2000, left: -2000, right: -2000, alignItems: 'center', justifyContent: 'center' },
  box: { width: 300, maxWidth: '90%', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 20 },
  title: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 20, marginTop: 18 },
  actionButton: { paddingVertical: 4 },
  actionText: { fontSize: 14, fontWeight: '600' },
  confirmText: { fontWeight: '700' },
});

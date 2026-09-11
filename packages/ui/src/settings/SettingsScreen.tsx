import type { ReactNode } from 'react';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { CrossfadeSlider } from './CrossfadeSlider';
import { BackButton } from '../BackButton';
import { HeaderRow } from '../HeaderRow';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import type { ThemeMode } from '../theme';
import { ACCENT_COLOR_OPTIONS } from './types';
import type { AppSettings } from './types';

export interface SettingsScreenProps {
  colors: Colors;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onResetSettings: () => void;
  onClose: () => void;
}

const THEME_MODE_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: 'Light' },
  { mode: 'flux', label: 'Flux' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'amoled', label: 'AMOLED' },
];

function Section({ title, colors, children }: { title: string; colors: Colors; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.subtleText }]}>{title}</Text>
      {children}
    </View>
  );
}

/**
 * Settings page (see CLAUDE.md's TODO): theme, accent color, volume
 * normalization, and crossfade duration, with a reset-to-defaults button.
 * Reachable from the gear button next to NotificationBell on every screen -
 * see HeaderActions.
 */
export function SettingsScreen({ colors, settings, onUpdateSettings, onResetSettings, onClose }: SettingsScreenProps) {
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <HeaderRow
        style={styles.header}
        left={<BackButton text="Settings" color={colors.text} onPress={onClose} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="Theme" colors={colors}>
          <View style={styles.choiceRow}>
            {THEME_MODE_OPTIONS.map(({ mode, label }) => {
              const selected = settings.themeMode === mode;
              return (
                <Pressable
                  key={mode}
                  onPress={() => onUpdateSettings({ themeMode: mode })}
                  style={[
                    styles.choice,
                    { borderColor: selected ? colors.accent : withAlpha(colors.text, 0.25) },
                    selected && { backgroundColor: colors.accent },
                  ]}
                >
                  <Text style={[styles.choiceText, { color: selected ? '#fff' : colors.text }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section title="Accent color" colors={colors}>
          <View style={styles.swatchRow}>
            {ACCENT_COLOR_OPTIONS.map((option) => {
              const selected = settings.accentColor === option.id;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => onUpdateSettings({ accentColor: option.id })}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  style={[
                    styles.swatch,
                    { backgroundColor: option.hex, borderColor: selected ? colors.text : 'transparent' },
                  ]}
                />
              );
            })}
          </View>
        </Section>

        <Section title="Playback" colors={colors}>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: colors.text }]}>Volume normalization</Text>
            <Switch
              value={settings.volumeNormalizationEnabled}
              onValueChange={(value) => onUpdateSettings({ volumeNormalizationEnabled: value })}
              trackColor={{ true: colors.accent }}
              // Android's default thumb color is a fixed teal, unrelated to
              // the app's own accent/theme - pinned to plain white instead
              // (same in both states) so only the track tints with accent.
              thumbColor="#ffffff"
            />
          </View>
          <View style={styles.crossfadeBlock}>
            <View style={styles.crossfadeHeaderRow}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>Crossfade duration</Text>
              <Text style={[styles.crossfadeValue, { color: colors.accent }]}>{settings.crossfadeSeconds}s</Text>
            </View>
            <CrossfadeSlider
              colors={colors}
              valueSeconds={settings.crossfadeSeconds}
              onChangeSeconds={(crossfadeSeconds) => onUpdateSettings({ crossfadeSeconds })}
            />
          </View>
        </Section>

        <Pressable onPress={() => setConfirmResetOpen(true)} style={[styles.resetButton, { borderColor: withAlpha(colors.text, 0.3) }]}>
          <Text style={[styles.resetButtonText, { color: colors.text }]}>Reset to defaults</Text>
        </Pressable>
      </ScrollView>
      {confirmResetOpen && (
        <View style={[StyleSheet.absoluteFill, styles.confirmOverlay]}>
          <View style={[styles.confirmCard, { backgroundColor: colors.background, borderColor: withAlpha(colors.text, 0.15) }]}>
            <Text style={[styles.confirmTitle, { color: colors.text }]}>Reset to defaults?</Text>
            <Text style={[styles.confirmMessage, { color: colors.subtleText }]}>
              Theme, accent color, volume normalization, and crossfade duration all go back to their default values.
            </Text>
            <View style={styles.confirmActions}>
              <Pressable onPress={() => setConfirmResetOpen(false)} style={styles.confirmButton}>
                <Text style={[styles.confirmButtonText, { color: colors.text }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  onResetSettings();
                  setConfirmResetOpen(false);
                }}
                style={styles.confirmButton}
              >
                <Text style={[styles.confirmButtonText, { color: colors.accent }]}>Reset</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
  },
  header: {
    maxWidth: 480,
    alignSelf: 'center',
  },
  content: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 24,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choice: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  choiceText: {
    fontSize: 14,
    fontWeight: '600',
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: {
    fontSize: 15,
  },
  crossfadeBlock: {
    gap: 10,
  },
  crossfadeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  crossfadeValue: {
    fontSize: 15,
    fontWeight: '700',
  },
  resetButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  resetButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  confirmOverlay: {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    gap: 12,
  },
  confirmTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  confirmMessage: {
    fontSize: 14,
    lineHeight: 20,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
    marginTop: 4,
  },
  confirmButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});

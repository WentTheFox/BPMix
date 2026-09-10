import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AppTitle } from './AppTitle';
import { RESTORING_STEPS, RestoringStepKey } from './restoringSteps';
import { Colors } from './theme';

export interface RestoringScreenProps {
  colors: Colors;
  /** Safe-area top inset (mobile only; web has none). */
  paddingTop?: number;
  completedSteps: Set<RestoringStepKey>;
  currentStep: RestoringStepKey | null;
  /** Hides the "Scanning lyrics" row entirely for a user with no lyrics scopes configured, rather than showing a row that can never complete. */
  hasLyricsScopes: boolean;
}

/**
 * Shown while both apps restore granted roots, scan the library/lyrics, and
 * restore the last playback state on launch (see usePlaybackPersistence's
 * isRestoring) - identical in both apps' App.tsx before this was extracted.
 *
 * Renders a fixed checklist of high-level phases (see restoringSteps.ts)
 * rather than a single line of ever-changing text, so this otherwise-silent
 * window (which can take a few seconds on a large library) reads as visible
 * progress instead of a hang.
 */
export function RestoringScreen({ colors, paddingTop, completedSteps, currentStep, hasLyricsScopes }: RestoringScreenProps) {
  const steps = RESTORING_STEPS.filter((step) => step.key !== 'scanningLyrics' || hasLyricsScopes);
  return (
    <View style={[styles.container, { paddingTop, backgroundColor: colors.background }]}>
      <AppTitle color={colors.text} accentColor={colors.accent} />
      <View style={styles.checklist}>
        {steps.map((step) => {
          const isDone = completedSteps.has(step.key);
          const isCurrent = step.key === currentStep;
          return (
            <View key={step.key} style={styles.row}>
              <View style={styles.indicator}>
                {isDone ? (
                  <View style={[styles.dot, { backgroundColor: colors.accent }]} />
                ) : isCurrent ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <View style={[styles.dot, styles.dotPending, { borderColor: colors.subtleText }]} />
                )}
              </View>
              <Text style={[styles.label, { color: colors.text, opacity: isDone || isCurrent ? 1 : 0.4 }]}>{step.label}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  checklist: {
    gap: 10,
    alignItems: 'flex-start',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  indicator: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotPending: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
  },
  label: {
    fontSize: 14,
  },
});

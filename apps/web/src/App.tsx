/**
 * BPMix - Stage 0 empty shell.
 */

import { CORE_PACKAGE_NAME } from '@bpmix/core';
import { StyleSheet, Text, View } from 'react-native';

function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>BPMix</Text>
      <Text style={styles.subtitle}>{CORE_PACKAGE_NAME} wired up</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: '100vh',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    opacity: 0.6,
  },
});

export default App;

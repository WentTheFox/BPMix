import { ScrollView, StyleSheet, View } from 'react-native';
import { BackButton } from '../BackButton';
import { HeaderRow } from '../HeaderRow';
import type { UseOfflineResult } from '../offline/useOffline';
import type { UseServerConnectionResult } from '../server/useServerConnection';
import type { Colors } from '../theme';
import { ServerSection } from './ServerSection';

export interface ServerScreenProps {
  colors: Colors;
  server: UseServerConnectionResult;
  /** Offline downloads, shown under the connection where the platform supports them. */
  offline?: UseOfflineResult | null;
  onClose: () => void;
}

/**
 * The BPMix server connection on its own screen off Settings: where the library, playlists and lyrics
 * come from (and sync between devices), signing in and out, and what is kept for offline play. Separate
 * from External connections, which is only for third-party services like Last.fm.
 */
export function ServerScreen({ colors, server, offline, onClose }: ServerScreenProps) {
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <HeaderRow style={styles.header} left={<BackButton text="BPMix server" color={colors.text} onPress={onClose} />} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ServerSection colors={colors} server={server} offline={offline} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, width: '100%' },
  header: { maxWidth: 480, alignSelf: 'center' },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 480, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 8 },
});

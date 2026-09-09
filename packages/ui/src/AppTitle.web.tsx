import { Image, StyleSheet, Text, View } from 'react-native';

export interface AppTitleProps {
  color: string;
}

/**
 * Web variant of AppTitle - see the default (mobile) implementation's doc
 * for why this needs a separate file rather than a shared require(): Vite
 * has no RN-style asset-registry shim, so a local require('./app-icon.png')
 * that works under Metro doesn't resolve the same way here. Points at the
 * already-published PWA icon (apps/web/public/icons/icon-192.png, served at
 * /icons/icon-192.png) instead of bundling a second copy of the same image.
 */
export function AppTitle({ color }: AppTitleProps) {
  return (
    <View style={styles.row}>
      <Image source={{ uri: '/icons/icon-192.png' }} style={styles.icon} />
      <Text style={[styles.title, { color }]}>BPMix</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  icon: {
    width: 22,
    height: 22,
    borderRadius: 5,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
});

import { normalizeServerUrl } from '@bpmix/core';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { navigateTo } from '../navigateTo';
import type { UseServerConnectionResult } from '../server/useServerConnection';
import { ServerSignInForm } from '../settings/ServerSignInForm';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';

export interface OnboardingScreenProps {
  colors: Colors;
  server: UseServerConnectionResult;
  /** The web app on a server whose first account hasn't been created yet: offer that instead of signing in. */
  setupRequired?: boolean;
  /** "Use folders on this device instead": leaves onboarding for the ordinary, empty library screen. */
  onUseLocalFolders: () => void;
}

/** The address an account can be created at (the server's own /setup page), or null while what's typed isn't an address yet. */
function setupAddress(typed: string): string | null {
  try {
    return `${normalizeServerUrl(typed)}/setup`;
  } catch {
    return null;
  }
}

/**
 * What a fresh install shows first: connecting to a BPMix server is the way to use the app (the library,
 * playlists, lyrics and playback position all follow the person between devices), with folders on this
 * device as the quieter alternative. Signing in finishes it by itself (see useOnboarding).
 */
export function OnboardingScreen({ colors, server, setupRequired = false, onUseLocalFolders }: OnboardingScreenProps) {
  const [typedAddress, setTypedAddress] = useState(server.status.url);
  // Only a native app needs this: the web app is served by the server, so it already knows whether accounts exist (setupRequired).
  const createAccountAt = server.usesBrowserSession ? null : setupAddress(typedAddress);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>Welcome to BPMix</Text>
        <Text style={[styles.lead, { color: colors.subtleText }]}>
          Connect to your BPMix server and your library, playlists and lyrics follow you from device to device.
        </Text>

        <View style={[styles.card, { borderColor: withAlpha(colors.text, 0.2) }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Connect to your server</Text>
          {setupRequired ? (
            <>
              <Text style={[styles.hint, { color: colors.subtleText }]}>This server has no accounts yet. The first account you create becomes its administrator.</Text>
              <Pressable onPress={() => navigateTo('/setup')} style={[styles.primary, { backgroundColor: colors.accent }]}>
                <Text style={styles.primaryText}>Create the first account</Text>
              </Pressable>
            </>
          ) : (
            <ServerSignInForm colors={colors} server={server} onAddressChange={setTypedAddress} />
          )}
          {!setupRequired && createAccountAt && (
            <Pressable onPress={() => void Linking.openURL(createAccountAt)} style={styles.linkRow}>
              <Text style={[styles.link, { color: colors.accent }]}>New server with no accounts yet? Create the first account in a browser</Text>
            </Pressable>
          )}
        </View>

        <Pressable onPress={onUseLocalFolders} style={[styles.secondary, { borderColor: withAlpha(colors.text, 0.25) }]}>
          <Text style={[styles.secondaryText, { color: colors.text }]}>Use folders on this device instead</Text>
        </Pressable>
        <Text style={[styles.hint, styles.centered, { color: colors.subtleText }]}>You can connect a server later from Settings.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, width: '100%' },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 480, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 48, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  lead: { fontSize: 15, lineHeight: 22, marginBottom: 24 },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 20 },
  cardTitle: { fontSize: 17, fontWeight: '600', marginBottom: 10 },
  hint: { fontSize: 13, marginBottom: 8 },
  centered: { textAlign: 'center', marginTop: 10 },
  primary: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondary: { borderWidth: 1, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  linkRow: { paddingTop: 12 },
  link: { fontSize: 13, fontWeight: '600' },
});

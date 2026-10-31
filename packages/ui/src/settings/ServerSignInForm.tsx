import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { UseServerConnectionResult } from '../server/useServerConnection';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';

export interface ServerSignInFormProps {
  colors: Colors;
  server: UseServerConnectionResult;
  /** Reports the address as it is typed, for a caller that offers something based on it (see OnboardingScreen's "create the first account" link). */
  onAddressChange?: (address: string) => void;
}

/**
 * Signing in to a BPMix server, without any surrounding section: on a native app the server's address
 * and then a code the person approves in a browser (passkeys and two-factor sign-in live there, so the
 * app never handles a password); on the web app served by the server itself just one button to its own
 * sign-in page. Shared by the server screen in Settings and the first-run onboarding.
 */
export function ServerSignInForm({ colors, server, onAddressChange }: ServerSignInFormProps) {
  const [address, setAddress] = useState(server.status.url);
  const { status } = server;
  const input = [styles.input, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }];
  const hint = [styles.hint, { color: colors.subtleText }];
  const link = (enabled = true) => [styles.linkValue, { color: enabled ? colors.accent : colors.subtleText }];

  if (server.usesBrowserSession) {
    return (
      <View>
        <Text style={hint}>Take your library from this BPMix server instead of this browser&apos;s folders.</Text>
        {status.error && <Text style={[styles.error, { color: '#dc2626' }]}>{status.error}</Text>}
        <Pressable onPress={() => server.signIn('')} style={styles.actionButton}>
          <Text style={link()}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  const busy = server.phase === 'starting' || server.phase === 'awaitingApproval';
  return (
    <View>
      <Text style={hint}>Take your library from a BPMix server instead of this device&apos;s folders.</Text>
      {status.error && <Text style={[styles.error, { color: '#dc2626' }]}>{status.error}</Text>}
      <TextInput
        style={input}
        placeholder="https://music.example.com"
        placeholderTextColor={colors.subtleText}
        value={address}
        onChangeText={(text) => {
          setAddress(text);
          onAddressChange?.(text);
        }}
        editable={!busy}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {server.phase === 'awaitingApproval' && server.pendingCode ? (
        <>
          <Text style={[styles.code, { color: colors.text }]} selectable>
            {server.pendingCode.userCode}
          </Text>
          <Text style={hint}>Approve this device in a browser where you&apos;re signed in to your server, using the code above.</Text>
          <Pressable onPress={server.openApprovalPage} style={styles.actionButton}>
            <Text style={link()}>Open the sign-in page</Text>
          </Pressable>
          <Text style={hint}>Waiting for approval…</Text>
        </>
      ) : server.phase === 'starting' ? (
        <Text style={hint}>Contacting the server…</Text>
      ) : (
        <Pressable disabled={address.trim().length === 0} onPress={() => server.signIn(address)} style={styles.actionButton}>
          <Text style={link(address.trim().length > 0)}>Sign in</Text>
        </Pressable>
      )}
      {busy && (
        <Pressable onPress={server.cancelSignIn} style={styles.actionButton}>
          <Text style={link()}>Cancel</Text>
        </Pressable>
      )}
      {server.phase === 'denied' && <Text style={[styles.error, { color: '#dc2626' }]}>That request was denied.</Text>}
      {server.phase === 'expired' && <Text style={[styles.error, { color: '#dc2626' }]}>That code expired. Try again.</Text>}
      {server.errorMessage && <Text style={[styles.error, { color: '#dc2626' }]}>{server.errorMessage}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  linkValue: { fontSize: 14, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 10 },
  actionButton: { paddingVertical: 10 },
  hint: { fontSize: 13, marginBottom: 6 },
  error: { fontSize: 13, marginTop: 6 },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 4, textAlign: 'center', paddingVertical: 12 },
});

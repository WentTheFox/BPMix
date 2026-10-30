import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { navigateTo } from '../navigateTo';
import { formatBytes } from '../offline/formatBytes';
import type { UseOfflineResult } from '../offline/useOffline';
import type { UseServerConnectionResult } from '../server/useServerConnection';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import { AppSwitch } from './AppSwitch';
import { Section } from './SettingsScreen';

/** "just now", "5 minutes ago", ... - good enough for a status line. */
function ago(timestampMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export interface ServerSectionProps {
  colors: Colors;
  server: UseServerConnectionResult;
  /** Downloads for offline play, where the platform supports them. */
  offline?: UseOfflineResult | null;
}

/** Choices for how much the downloads that weren't asked for may take (0 = no limit). Decimal, like the sizes shown. */
const STORAGE_LIMITS = [
  { bytes: 0, label: 'No limit' },
  { bytes: 1_000_000_000, label: '1 GB' },
  { bytes: 5_000_000_000, label: '5 GB' },
  { bytes: 20_000_000_000, label: '20 GB' },
];

/**
 * Where the app's library comes from: this device's own folders, or a BPMix server. Signing in uses a
 * code the person approves in a browser (where passkeys and two-factor sign-in live), so the app never
 * handles a password.
 */
export function ServerSection({ colors, server, offline }: ServerSectionProps) {
  const [address, setAddress] = useState(server.status.url);
  const { status } = server;
  const input = [styles.input, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }];
  const hint = [styles.hint, { color: colors.subtleText }];
  const spaced = { marginBottom: 20 };
  const link = (enabled = true) => [styles.linkValue, { color: enabled ? colors.accent : colors.subtleText }];

  if (status.active) {
    return (
      <View style={spaced}>
        <Section title="BPMix server" colors={colors}>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: colors.text }]}>Signed in as</Text>
            <Text style={[styles.rowValue, { color: colors.subtleText }]}>{status.userName ?? 'unknown'}</Text>
          </View>
          <Text style={hint}>{status.url || 'This site'}</Text>
          <Text style={hint}>
            {status.syncing
              ? 'Syncing…'
              : status.offline
                ? `Offline - showing the library as of ${status.lastSyncedAtMs ? ago(status.lastSyncedAtMs, Date.now()) : 'your last sync'}.`
                : status.lastSyncedAtMs
                  ? `Synced ${ago(status.lastSyncedAtMs, Date.now())}.`
                  : 'Not synced yet.'}
          </Text>
          {status.error && <Text style={[styles.error, { color: '#dc2626' }]}>{status.error}</Text>}
          <Pressable disabled={status.syncing} onPress={server.syncNow} style={styles.actionButton}>
            <Text style={link(!status.syncing)}>Sync now</Text>
          </Pressable>
          {offline && (
            <>
              <Text style={hint}>
                {offline.state.downloadedCount === 0
                  ? 'No tracks downloaded for offline play.'
                  : `${offline.state.downloadedCount} track${offline.state.downloadedCount === 1 ? '' : 's'} downloaded (${formatBytes(offline.state.downloadedBytes)}).`}
                {offline.state.activeCount + offline.state.queuedCount > 0 ? ` Downloading ${offline.state.activeCount + offline.state.queuedCount} more…` : ''}
              </Text>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Keep played tracks</Text>
                <AppSwitch value={offline.state.cacheOnPlay} onValueChange={offline.setCacheOnPlay} accentColor={colors.accent} />
              </View>
              <Text style={hint}>Tracks are saved on this device as you play them, and the least recently played go first when over the limit.</Text>
              <Text style={[styles.rowLabel, { color: colors.text }]}>Storage limit</Text>
              <View style={styles.choiceRow}>
                {STORAGE_LIMITS.map(({ bytes, label }) => {
                  const selected = offline.state.budgetBytes === bytes;
                  return (
                    <Pressable
                      key={bytes}
                      onPress={() => offline.setBudgetBytes(bytes)}
                      style={[styles.choice, { borderColor: selected ? colors.accent : withAlpha(colors.text, 0.25) }, selected && { backgroundColor: colors.accent }]}
                    >
                      <Text style={[styles.choiceText, { color: selected ? '#fff' : colors.text }]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={hint}>Tracks you chose to download are never removed to make room.</Text>
              {offline.state.paused && offline.state.queuedCount > 0 && (
                <Pressable onPress={offline.resume} style={styles.actionButton}>
                  <Text style={link()}>Downloads are waiting for the server - try again</Text>
                </Pressable>
              )}
              {offline.state.failures.length > 0 && (
                <Text style={[styles.error, { color: '#dc2626' }]}>
                  {offline.state.failures.length} download{offline.state.failures.length === 1 ? '' : 's'} failed: {offline.state.failures[offline.state.failures.length - 1]!.message}
                </Text>
              )}
              {offline.state.downloadedCount > 0 && (
                <Pressable onPress={offline.clear} style={styles.actionButton}>
                  <Text style={link()}>Clear downloads</Text>
                </Pressable>
              )}
            </>
          )}
          {server.usesBrowserSession && (
            <Pressable onPress={() => navigateTo('/account')} style={styles.actionButton}>
              <Text style={link()}>Manage your account</Text>
            </Pressable>
          )}
          <Pressable onPress={server.signOut} style={styles.actionButton}>
            <Text style={link()}>Sign out</Text>
          </Pressable>
        </Section>
      </View>
    );
  }

  if (server.usesBrowserSession) {
    return (
      <View style={spaced}>
        <Section title="BPMix server" colors={colors}>
          <Text style={hint}>Take your library from this BPMix server instead of this browser&apos;s folders.</Text>
          {status.error && <Text style={[styles.error, { color: '#dc2626' }]}>{status.error}</Text>}
          <Pressable onPress={() => server.signIn('')} style={styles.actionButton}>
            <Text style={link()}>Sign in</Text>
          </Pressable>
        </Section>
      </View>
    );
  }

  const busy = server.phase === 'starting' || server.phase === 'awaitingApproval';
  return (
    <View style={spaced}>
      <Section title="BPMix server" colors={colors}>
        <Text style={hint}>Take your library from a BPMix server instead of this device&apos;s folders.</Text>
        {status.error && <Text style={[styles.error, { color: '#dc2626' }]}>{status.error}</Text>}
        <TextInput
          style={input}
          placeholder="https://music.example.com"
          placeholderTextColor={colors.subtleText}
          value={address}
          onChangeText={setAddress}
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
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: 15 },
  rowValue: { fontSize: 14 },
  linkValue: { fontSize: 14, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 10 },
  actionButton: { paddingVertical: 10 },
  hint: { fontSize: 13, marginBottom: 6 },
  error: { fontSize: 13, marginTop: 6 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 8 },
  choice: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  choiceText: { fontSize: 14, fontWeight: '600' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 4, textAlign: 'center', paddingVertical: 12 },
});

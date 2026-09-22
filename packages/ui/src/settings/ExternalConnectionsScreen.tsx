import { DEFAULT_LASTFM_API_KEY, DEFAULT_LASTFM_API_SECRET } from '@bpmix/core';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BackButton } from '../BackButton';
import { HeaderRow } from '../HeaderRow';
import type { UseLastFmConnectionResult } from '../scrobble/useLastFmConnection';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import { Section } from './SettingsScreen';
import type { AppSettings } from './types';

const LASTFM_API_ACCOUNT_URL = 'https://www.last.fm/api/account/create';

export interface ExternalConnectionsScreenProps {
  colors: Colors;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  lastFm: UseLastFmConnectionResult;
  onClose: () => void;
}

/**
 * Third-party service connections (currently just Last.fm) - its own
 * sub-screen off Settings rather than an inline section there, and its own
 * explicit Save button rather than writing to LibraryStore's settings
 * store on every keystroke (SettingsScreen's other fields - sliders,
 * switches, discrete choices - only ever change a handful of times a
 * session, so a write per change is cheap; a free-text API key/secret field
 * writing on every character typed isn't, and there's no legitimate reason
 * to persist a half-typed credential anyway). Save and Connect are
 * deliberately separate steps: Save just persists the credentials Connect
 * then reads from `settings` to start the auth flow.
 *
 * BPMix ships with its own Last.fm API app (DEFAULT_LASTFM_API_KEY/SECRET -
 * see that constant's doc for why sharing one across installs is the normal
 * approach, not a shortcut) - the common case needs no key entry at all,
 * just Connect. The key/secret fields only surface behind "Use your own
 * Last.fm API app instead", for a fork or self-hoster who'd rather use
 * their own app identity.
 */
export function ExternalConnectionsScreen({ colors, settings, onUpdateSettings, lastFm, onClose }: ExternalConnectionsScreenProps) {
  const usingDefaultCredentials = settings.lastFmApiKey === DEFAULT_LASTFM_API_KEY && settings.lastFmApiSecret === DEFAULT_LASTFM_API_SECRET;
  const [showOwnKey, setShowOwnKey] = useState(!usingDefaultCredentials);
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.lastFmApiKey);
  const [apiSecretDraft, setApiSecretDraft] = useState(settings.lastFmApiSecret);
  const dirty = apiKeyDraft !== settings.lastFmApiKey || apiSecretDraft !== settings.lastFmApiSecret;
  const saved = settings.lastFmApiKey.length > 0 && settings.lastFmApiSecret.length > 0;
  const editable = lastFm.status === 'disconnected';

  const connectionControls = (
    <>
      {lastFm.status === 'disconnected' && (
        <Pressable onPress={lastFm.connect} style={styles.actionButton}>
          <Text style={[styles.linkValue, { color: colors.accent }]}>Connect</Text>
        </Pressable>
      )}
      {lastFm.status === 'requestingToken' && <Text style={[styles.hint, { color: colors.subtleText }]}>Requesting authorization…</Text>}
      {lastFm.status === 'awaitingAuthorization' &&
        (lastFm.needsManualConfirmation ? (
          <Pressable onPress={lastFm.confirmAuthorized} style={styles.actionButton}>
            <Text style={[styles.linkValue, { color: colors.accent }]}>I&apos;ve approved it in the browser</Text>
          </Pressable>
        ) : (
          <Text style={[styles.hint, { color: colors.subtleText }]}>Waiting for you to approve in the browser…</Text>
        ))}
      {lastFm.status === 'confirming' && <Text style={[styles.hint, { color: colors.subtleText }]}>Confirming…</Text>}
      {lastFm.errorMessage && <Text style={[styles.error, { color: '#dc2626' }]}>{lastFm.errorMessage}</Text>}
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <HeaderRow style={styles.header} left={<BackButton text="External connections" color={colors.text} onPress={onClose} />} />
      <View style={styles.content}>
        <Section title="Last.fm" colors={colors}>
          {lastFm.status === 'connected' ? (
            <>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Connected as</Text>
                <Text style={[styles.rowValue, { color: colors.subtleText }]}>{lastFm.username}</Text>
              </View>
              <Pressable onPress={lastFm.disconnect} style={styles.actionButton}>
                <Text style={[styles.linkValue, { color: colors.accent }]}>Disconnect</Text>
              </Pressable>
            </>
          ) : !showOwnKey ? (
            <>
              {connectionControls}
              <Pressable onPress={() => setShowOwnKey(true)} style={styles.actionButton}>
                <Text style={[styles.hint, styles.advancedLink, { color: colors.subtleText }]}>Use your own Last.fm API app instead</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={[styles.hint, styles.apiKeyHint, { color: colors.subtleText }]}>
                Needs a Last.fm API account (free) - register one at{' '}
                <Text style={{ color: colors.accent, fontWeight: '600' }} onPress={() => void Linking.openURL(LASTFM_API_ACCOUNT_URL)}>
                  last.fm/api/account/create
                </Text>
                , then paste its API key and shared secret below.
              </Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }]}
                placeholder="Last.fm API key"
                placeholderTextColor={colors.subtleText}
                value={apiKeyDraft}
                onChangeText={setApiKeyDraft}
                editable={editable}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: withAlpha(colors.text, 0.25) }]}
                placeholder="Last.fm API secret"
                placeholderTextColor={colors.subtleText}
                value={apiSecretDraft}
                onChangeText={setApiSecretDraft}
                editable={editable}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                disabled={!dirty}
                onPress={() => onUpdateSettings({ lastFmApiKey: apiKeyDraft, lastFmApiSecret: apiSecretDraft })}
                style={styles.actionButton}
              >
                <Text style={[styles.linkValue, { color: dirty ? colors.accent : colors.subtleText }]}>Save</Text>
              </Pressable>

              {dirty ? (
                <Text style={[styles.hint, { color: colors.subtleText }]}>Save your changes before connecting.</Text>
              ) : !saved ? (
                <Text style={[styles.hint, { color: colors.subtleText }]}>Enter and save a Last.fm API key and secret to connect.</Text>
              ) : (
                connectionControls
              )}

              {editable && (
                <Pressable
                  onPress={() => {
                    setApiKeyDraft(DEFAULT_LASTFM_API_KEY);
                    setApiSecretDraft(DEFAULT_LASTFM_API_SECRET);
                    onUpdateSettings({ lastFmApiKey: DEFAULT_LASTFM_API_KEY, lastFmApiSecret: DEFAULT_LASTFM_API_SECRET });
                    setShowOwnKey(false);
                  }}
                  style={styles.actionButton}
                >
                  <Text style={[styles.hint, styles.advancedLink, { color: colors.subtleText }]}>Use BPMix&apos;s shared API app instead</Text>
                </Pressable>
              )}
            </>
          )}
        </Section>
      </View>
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
    paddingTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: {
    fontSize: 15,
  },
  rowValue: {
    fontSize: 14,
  },
  linkValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  actionButton: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  hint: {
    fontSize: 13,
    marginTop: 4,
  },
  advancedLink: {
    textDecorationLine: 'underline',
    marginTop: 12,
  },
  apiKeyHint: {
    marginTop: 0,
    marginBottom: 12,
    lineHeight: 18,
  },
  error: {
    fontSize: 12,
    marginTop: 4,
  },
});

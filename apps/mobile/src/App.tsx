import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { inferDevelopmentUrl, normalizeServerUrl } from './connection';

const storageKey = 'brain.server-url.v1';
const development = __DEV__ || Constants.expoConfig?.extra?.allowLocal === true;
const defaultUrl =
  process.env.EXPO_PUBLIC_BRAIN_URL ||
  (development ? inferDevelopmentUrl(Constants.expoConfig?.hostUri) : '');

function BrainShell() {
  const web = useRef<WebView>(null);
  const [url, setUrl] = useState('');
  const liveUrl = useRef(url);
  liveUrl.current = url;
  const [draft, setDraft] = useState(defaultUrl);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(storageKey);
        const value = saved || defaultUrl;
        if (!mounted) return;
        setDraft(value);
        if (value) setUrl(normalizeServerUrl(value, development));
        else setSettings(true);
      } catch (failure) {
        if (mounted) {
          setValidation(
            failure instanceof Error ? failure.message : 'Could not read your saved connection.',
          );
          setSettings(true);
        }
      } finally {
        if (mounted) setReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (settings && url) {
        setSettings(false);
        return true;
      }
      if (canGoBack) {
        web.current?.goBack();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [canGoBack, settings, url]);
  const retry = () => {
    setError('');
    setLoading(true);
    setRevision((value) => value + 1);
  };
  const connect = async () => {
    try {
      const next = normalizeServerUrl(draft, development);
      await AsyncStorage.setItem(storageKey, next);
      setUrl(next);
      setDraft(next);
      setSettings(false);
      setValidation('');
      retry();
    } catch (failure) {
      setValidation(failure instanceof Error ? failure.message : 'Could not save the connection.');
    }
  };
  return (
    <SafeAreaView style={styles.page}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.bar}>
        <Text style={styles.brand}>
          my little brain<Text style={styles.dot}> ·</Text>
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connection settings"
          onPress={() => {
            setDraft(url || defaultUrl);
            setValidation('');
            setSettings(true);
          }}
          style={styles.settingButton}
        >
          <Text style={styles.muted}>Connection</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {ready && url && !error ? (
          <WebView
            key={`${url}:${revision}`}
            ref={web}
            style={styles.web}
            source={{ uri: url }}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(request) => {
              try {
                return new URL(request.url).origin === new URL(url).origin;
              } catch {
                return false;
              }
            }}
            injectedJavaScriptBeforeContentLoaded={`window.brainMobile={platform:${JSON.stringify(Platform.OS)}};true;`}
            onMessage={async (event) => {
              let message: {
                type?: string;
                action?: string;
                requestId?: string;
                origin?: string;
                raw?: string;
              };
              try {
                message = JSON.parse(event.nativeEvent.data);
              } catch {
                return;
              }
              if (
                message.type !== 'brain:workspace' ||
                typeof message.requestId !== 'string' ||
                message.origin !== new URL(url).origin ||
                new URL(event.nativeEvent.url).origin !== new URL(url).origin
              )
                return;
              const requestId = message.requestId;
              const reply = (value: object) => {
                if (liveUrl.current !== url) return;
                web.current?.injectJavaScript(
                  `window.dispatchEvent(new CustomEvent('little-brain.native-response',{detail:${JSON.stringify({ requestId, ...value }).replace(/</g, '\\u003c')}}));true;`,
                );
              };
              try {
                // A device-local archive for each server origin prevents a different server from obtaining another brain's history.
                const key = `brain.local-backup.v1:${new URL(url).origin}`;
                if (message.action === 'read') reply({ raw: await AsyncStorage.getItem(key) });
                else if (
                  (message.action === 'write' || message.action === 'export') &&
                  typeof message.raw === 'string' &&
                  message.raw.length <= 12_000_000
                ) {
                  JSON.parse(message.raw);
                  if (message.action === 'write') {
                    const prior = await AsyncStorage.getItem(key);
                    if (prior !== null && prior !== message.raw)
                      await AsyncStorage.setItem(`${key}:previous`, prior);
                    await AsyncStorage.setItem(key, message.raw);
                  } else {
                    if (!(await Sharing.isAvailableAsync()))
                      throw new Error('File sharing is unavailable on this device.');
                    const path = `${FileSystem.cacheDirectory}little-brain-${Date.now()}.json`;
                    await FileSystem.writeAsStringAsync(path, message.raw);
                    try {
                      await Sharing.shareAsync(path, {
                        mimeType: 'application/json',
                        UTI: 'public.json',
                        dialogTitle: 'Save your brain backup',
                      });
                    } finally {
                      await FileSystem.deleteAsync(path, { idempotent: true });
                    }
                  }
                  reply({});
                } else reply({ error: 'Invalid native backup request.' });
              } catch (failure) {
                reply({
                  error: failure instanceof Error ? failure.message : 'Native storage failed.',
                });
              }
            }}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            mediaCapturePermissionGrantType="prompt"
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically={false}
            mixedContentMode="never"
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onNavigationStateChange={(state) => setCanGoBack(state.canGoBack)}
            onError={(event) => {
              setLoading(false);
              setError(event.nativeEvent.description || 'The server is unavailable.');
            }}
            onHttpError={(event) => {
              if (event.nativeEvent.url === url || event.nativeEvent.url === `${url}/`) {
                setLoading(false);
                setError(`The server returned HTTP ${event.nativeEvent.statusCode}.`);
              }
            }}
            onContentProcessDidTerminate={retry}
            onRenderProcessGone={retry}
          />
        ) : null}
        {error ? (
          <View style={styles.center}>
            <Text style={styles.title}>Your brain is out of reach</Text>
            <Text style={styles.description}>{error}</Text>
            <Text style={styles.muted}>{url}</Text>
            <Pressable accessibilityRole="button" style={styles.primary} onPress={retry}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        {loading && !error && !settings ? (
          <View
            style={[StyleSheet.absoluteFill, styles.center, styles.loading]}
            pointerEvents="none"
          >
            <ActivityIndicator color="#708863" />
            <Text style={styles.muted}>Connecting to your brain…</Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
      <Modal
        visible={settings}
        animationType="slide"
        onRequestClose={() => {
          if (url) setSettings(false);
        }}
      >
        <SafeAreaView style={styles.page}>
          <KeyboardAvoidingView
            style={styles.center}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Text style={styles.eyebrow}>A PLACE FOR YOUR MIND</Text>
            <Text style={styles.title}>Connect your brain</Text>
            <Text style={styles.description}>
              Enter the address of your My Little Brain server. Your twins and conversations stay in
              this device’s web storage and a native local backup.
            </Text>
            <TextInput
              accessibilityLabel="Brain server URL"
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://brain.example.com"
              placeholderTextColor="#889183"
              returnKeyType="go"
              onSubmitEditing={() => void connect()}
            />
            {validation ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {validation}
              </Text>
            ) : null}
            <Text style={styles.description}>
              {development
                ? 'For local development, connect to the same Wi-Fi as your computer and use its LAN address on port 5173. Microphone access requires HTTPS.'
                : 'Use HTTPS and protect your server with an access token. Enter the token in the brain’s Settings after connecting.'}
            </Text>
            <Pressable
              accessibilityRole="button"
              style={styles.primary}
              onPress={() => void connect()}
            >
              <Text style={styles.primaryText}>Connect</Text>
            </Pressable>
            {url ? (
              <Pressable
                accessibilityRole="button"
                style={styles.settingButton}
                onPress={() => setSettings(false)}
              >
                <Text style={styles.muted}>Cancel</Text>
              </Pressable>
            ) : null}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <BrainShell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8f5' },
  content: { flex: 1 },
  web: { flex: 1, backgroundColor: '#f7f8f5' },
  bar: {
    height: 44,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#e1e6dc',
  },
  brand: { color: '#34463e', fontWeight: '600', fontSize: 14 },
  dot: { color: '#708863' },
  muted: { color: '#788579', fontSize: 12 },
  settingButton: { padding: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 18 },
  loading: { backgroundColor: '#f7f8f5' },
  title: { color: '#34463e', fontSize: 27, fontWeight: '600', textAlign: 'center' },
  description: {
    color: '#788579',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 22,
    maxWidth: 420,
  },
  eyebrow: { color: '#708863', fontSize: 10, letterSpacing: 2 },
  input: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    color: '#34463e',
    borderColor: '#d6dfd0',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 15,
  },
  primary: {
    backgroundColor: '#708863',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  primaryText: { color: '#ffffff', fontWeight: '700' },
  error: { color: '#a94f4f', textAlign: 'center' },
});

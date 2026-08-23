// Settings → Sync. Connects this device to a self-hosted sync server. Mirrors
// apps/web/src/components/SyncPane.tsx.
//
// The server only ever receives ciphertext (SYNC-DESIGN.md §1). The master password is used
// here solely to derive the one-way auth token locally; it is never sent and never stored.
import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { deriveAuthToken, SyncClient } from "@pw/sync";
import { useStore, useVault } from "../vault/VaultContext";
import { Button, Card, Field, SectionTitle, WarningBanner } from "../components/ui";
import { colors, spacing } from "../theme";

export function SyncScreen() {
  const store = useStore();
  const { syncIdentity, updateSyncConfig, authTokenB64, syncStatus, syncNow, reauthPassword } = useVault();
  const sync = syncIdentity.sync;

  const [serverUrl, setServerUrl] = useState(sync.serverUrl);
  const [accountId, setAccountId] = useState(sync.accountId);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const client = (url: string) =>
    new SyncClient({
      fetch: fetch as unknown as typeof fetch,
      serverUrl: url,
      deviceId: syncIdentity.deviceId,
      deviceLabel: syncIdentity.deviceLabel,
    });

  const httpsWarning = serverUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(serverUrl);

  /** Create a brand-new account on this server from this device's vault. */
  const createAccount = async () => {
    setErr("");
    const pw = await reauthPassword(
      "Confirm your master password to set up sync. It is used only to derive a login token on this device — it is never sent to the server.",
    );
    if (!pw) return;
    setBusy("Creating account…");
    try {
      const token = deriveAuthToken(pw, store.getHeader().kdf);
      const id = await client(serverUrl).register(syncIdentity.deviceLabel, token, store);
      updateSyncConfig({ enabled: true, serverUrl: serverUrl.trim(), accountId: id, lastError: null });
      setAccountId(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  /** Point this device at an account created on another device. */
  const connectExisting = async () => {
    setErr("");
    const pw = await reauthPassword("Confirm your master password to connect this device to your sync account.");
    if (!pw) return;
    setBusy("Connecting…");
    try {
      const c = client(serverUrl);
      const token = deriveAuthToken(pw, store.getHeader().kdf);
      await c.login(accountId.trim(), token);
      updateSyncConfig({
        enabled: true,
        serverUrl: serverUrl.trim(),
        accountId: accountId.trim(),
        lastError: null,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const disable = () => updateSyncConfig({ enabled: false });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <SectionTitle>Sync across devices</SectionTitle>
      <Card>
        <Text style={{ color: colors.subtext, marginBottom: spacing.md }}>
          Keep this vault in step with your other devices through your own server. The server
          stores only encrypted data — it can never read your passwords, and there is no
          account recovery through it. Your master password never leaves this device.
        </Text>

        {!sync.enabled && (
          <>
            <Field
              label="Sync server address"
              autoCapitalize="none"
              autoCorrect={false}
              value={serverUrl}
              placeholder="https://vault-sync.example.in"
              onChangeText={setServerUrl}
            />
            {httpsWarning && (
              <WarningBanner text="This address is not HTTPS. Anything sent over plain HTTP can be read or altered in transit. Use an https:// address." />
            )}
            <Field
              label="Existing account ID (leave blank to create a new one)"
              autoCapitalize="none"
              autoCorrect={false}
              value={accountId}
              placeholder="from your first device's Sync settings"
              onChangeText={setAccountId}
            />
            {err ? <Text style={{ color: colors.danger, marginBottom: spacing.sm }}>{err}</Text> : null}
            <Button
              title={busy || (accountId.trim() ? "Connect this device" : "Create sync account")}
              onPress={() => void (accountId.trim() ? connectExisting() : createAccount())}
              disabled={!serverUrl || !!busy || httpsWarning}
              busy={!!busy}
            />
          </>
        )}

        {sync.enabled && (
          <>
            <View style={styles.kv}>
              <Text style={styles.kvLabel}>Server</Text>
              <Text style={styles.kvValue}>{sync.serverUrl}</Text>
            </View>
            <View style={styles.kv}>
              <Text style={styles.kvLabel}>Account ID</Text>
              <Text style={styles.kvValue} selectable>{sync.accountId}</Text>
            </View>
            <View style={styles.kv}>
              <Text style={styles.kvLabel}>This device</Text>
              <Text style={styles.kvValue}>{syncIdentity.deviceLabel}</Text>
            </View>
            <View style={styles.kv}>
              <Text style={styles.kvLabel}>Last sync</Text>
              <Text style={styles.kvValue}>
                {sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : "not yet"}
              </Text>
            </View>

            {!authTokenB64 && (
              <WarningBanner text="Sync is on but this session cannot sign in yet. Lock and unlock the vault once — the login token is derived from your master password at unlock." />
            )}
            {sync.lastError ? <WarningBanner text={sync.lastError} /> : null}
            {syncStatus.lastOutcome && syncStatus.lastOutcome.conflicts.length > 0 && (
              <WarningBanner
                text={`${syncStatus.lastOutcome.conflicts.length} item(s) need review — they were changed on two devices at once. Both versions were kept; search for "conflicted copy" and delete the one you do not want.`}
              />
            )}

            <View style={{ height: spacing.sm }} />
            <Button title={syncStatus.busy ? "Syncing…" : "Sync now"} onPress={() => void syncNow()} busy={syncStatus.busy} />
            <Button title="Turn off sync" kind="secondary" onPress={disable} />

            <Text style={{ color: colors.subtext, marginTop: spacing.md, fontSize: 13 }}>
              To add another device: install the app there, restore this vault from a backup or
              create it with the same master password, then enter this account ID in its Sync
              settings.
            </Text>
          </>
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  kv: { marginBottom: spacing.sm },
  kvLabel: { color: colors.subtext, fontSize: 12 },
  kvValue: { color: colors.text, fontSize: 15 },
});

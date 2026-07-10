// Unlock screen: master password, biometric button when enrolled, and the recovery-key
// path. After the FIRST successful master-password unlock we offer biometric unlock
// (see src/security/biometric.ts for the pattern).
import React, { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
} from "react-native";
import { WrongCredentialError } from "@pw/core";
import { useVault } from "../vault/VaultContext";
import { biometricLabel, biometricsAvailable } from "../security/biometric";
import { Button, Field } from "../components/ui";
import { colors, spacing } from "../theme";

export function UnlockScreen({ onRecover }: { onRecover: () => void }) {
  const { unlockWithPassword, unlockWithBiometrics, prefs, enableBiometrics, setPrefs } = useVault();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLabel, setBioLabel] = useState("Biometric unlock");

  useEffect(() => {
    void (async () => {
      const avail = await biometricsAvailable();
      setBioAvailable(avail);
      if (avail) setBioLabel(await biometricLabel());
    })();
  }, []);

  // Auto-offer biometric unlock on mount when enabled.
  useEffect(() => {
    if (prefs.biometricEnabled && bioAvailable) void unlockWithBiometrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bioAvailable]);

  const unlock = async () => {
    setError("");
    setBusy(true);
    try {
      const pw = password;
      await unlockWithPassword(pw);
      setPassword("");
      // First successful master-password unlock: offer biometric unlock once.
      if (prefs.biometricEnabled === null && (await biometricsAvailable())) {
        const label = await biometricLabel();
        Alert.alert(
          `Enable ${label} unlock?`,
          `Your master password will be stored in this device's secure keychain, readable only after ${label}. You can turn this off any time in Settings.`,
          [
            { text: "Not now", style: "cancel", onPress: () => setPrefs({ biometricEnabled: false }) },
            { text: "Enable", onPress: () => void enableBiometrics(pw) },
          ],
        );
      }
    } catch (e) {
      setError(
        e instanceof WrongCredentialError ? e.message : "Could not unlock the vault.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.lock}>🔒</Text>
        <Text style={styles.title}>Password Vault</Text>
        <Text style={styles.subtitle}>Locked — enter your master password</Text>
        <Field
          placeholder="Master password"
          secureTextEntry
          value={password}
          onChangeText={(t) => {
            setPassword(t);
            setError("");
          }}
          onSubmitEditing={unlock}
          returnKeyType="go"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Unlock" onPress={unlock} busy={busy} disabled={!password} />
        {prefs.biometricEnabled && bioAvailable ? (
          <Button title={`Unlock with ${bioLabel}`} kind="secondary" onPress={() => void unlockWithBiometrics()} />
        ) : null}
        <TouchableOpacity onPress={onRecover} style={{ marginTop: spacing.xl }}>
          <Text style={styles.link}>Forgot your master password? Use your recovery key</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingTop: 100 },
  lock: { fontSize: 44, textAlign: "center", marginBottom: spacing.md },
  title: { fontSize: 26, fontWeight: "700", color: colors.text, textAlign: "center" },
  subtitle: { color: colors.subtext, textAlign: "center", marginBottom: spacing.xl },
  error: { color: colors.danger, marginBottom: spacing.md },
  link: { color: colors.primary, textAlign: "center", fontWeight: "600" },
});

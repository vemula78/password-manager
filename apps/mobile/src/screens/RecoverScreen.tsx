// Recovery-key recovery: unlock the vault with the recovery key, then FORCE a new master
// password (fresh salt, fresh KEK — item ciphertexts untouched) and strongly encourage
// rotating the recovery key, since the old one keeps working until rotated.
import React, { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { usePreventScreenCapture } from "expo-screen-capture";
import { VaultStore, WrongCredentialError, estimateStrength } from "@pw/core";
import { useVault } from "../vault/VaultContext";
import { clearStoredMasterPassword } from "../security/biometric";
import { Button, Field, StrengthBar, WarningBanner } from "../components/ui";
import { RecoveryKeyCard } from "../components/RecoveryKeyCard";
import { colors, spacing } from "../theme";

export function RecoverScreen({ onCancel }: { onCancel: () => void }) {
  usePreventScreenCapture("recover");
  const { unlockWithRecoveryKey, setPrefs } = useVault();
  const [step, setStep] = useState<"key" | "newPassword" | "rotate">("key");
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [store, setStore] = useState<VaultStore | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const strength = useMemo(() => estimateStrength(newPassword), [newPassword]);

  const tryUnlock = async () => {
    setError("");
    setBusy(true);
    try {
      const s = await unlockWithRecoveryKey(recoveryKeyInput);
      setStore(s);
      setStep("newPassword");
    } catch (e) {
      setError(e instanceof WrongCredentialError ? e.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  };

  const setPassword = async () => {
    if (!store) return;
    setError("");
    if (newPassword.length < 8) {
      setError("Use at least 8 characters — a long passphrase is best.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await store.changeMasterPassword(newPassword);
      // Any biometric-cached master password is now stale — remove it.
      await clearStoredMasterPassword();
      setPrefs({ biometricEnabled: null }); // re-offer on next password unlock
      const rotated = await store.createRecoveryKey(); // old key would still open the vault otherwise
      setNewRecoveryKey(rotated);
      setNewPassword("");
      setConfirm("");
      setStep("rotate");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set the new password.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "rotate" && newRecoveryKey && store) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <WarningBanner text="Your master password was changed and a NEW recovery key was generated. The old recovery key no longer works." />
        <RecoveryKeyCard
          recoveryKey={newRecoveryKey}
          clipboardClearSeconds={store.settings.clipboardClearSeconds}
          onConfirmed={() => {
            setNewRecoveryKey(null);
            onCancel(); // provider is already unlocked; leave the recovery flow
          }}
        />
      </ScrollView>
    );
  }

  if (step === "newPassword") {
    return (
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Set a new master password</Text>
          <Text style={styles.subtitle}>
            Recovery unlocked your vault. You must set a new master password now.
          </Text>
          <Field
            label="New master password"
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
          />
          {newPassword ? <StrengthBar strength={strength.strength} bits={strength.bits} /> : null}
          <Field label="Confirm" secureTextEntry value={confirm} onChangeText={setConfirm} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button title="Set new master password" onPress={setPassword} busy={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Recover with recovery key</Text>
        <Text style={styles.subtitle}>
          Enter the 26-character recovery key from your emergency kit (dashes optional).
        </Text>
        <Field
          placeholder="ABCDE-FGHJK-…"
          autoCapitalize="characters"
          value={recoveryKeyInput}
          onChangeText={(t) => {
            setRecoveryKeyInput(t);
            setError("");
          }}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Recover vault" onPress={tryUnlock} busy={busy} disabled={!recoveryKeyInput} />
        <TouchableOpacity onPress={onCancel} style={{ marginTop: spacing.lg }}>
          <Text style={styles.link}>Back to unlock</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingTop: 80 },
  title: { fontSize: 24, fontWeight: "700", color: colors.text, marginBottom: spacing.sm },
  subtitle: { color: colors.subtext, marginBottom: spacing.xl, lineHeight: 20 },
  error: { color: colors.danger, marginBottom: spacing.md },
  link: { color: colors.primary, textAlign: "center", fontWeight: "600" },
});

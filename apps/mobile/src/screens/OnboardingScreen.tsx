// Create-vault onboarding: passphrase-encouraged master password with live strength via
// core's estimateStrength, then the mandatory recovery-kit step (generate recovery key,
// show once, confirm stored). Also offers restore-from-backup for users moving devices.
import React, { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { estimateStrength, generatePassphrase } from "@pw/core";
import { useVault } from "../vault/VaultContext";
import { Button, Field, StrengthBar, WarningBanner } from "../components/ui";
import { RecoveryKeyCard } from "../components/RecoveryKeyCard";
import { colors, spacing } from "../theme";

export function OnboardingScreen({ onRestoreInstead }: { onRestoreInstead: () => void }) {
  const { createVault, store } = useVault();
  const [step, setStep] = useState<"password" | "kit" | "done">("password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const strength = useMemo(() => estimateStrength(password), [password]);

  const create = async () => {
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters — a long passphrase of 4–5 words is best.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const s = await createVault(password);
      const key = await s.createRecoveryKey({ masterPassword: password });
      setRecoveryKey(key);
      setStep("kit");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the vault.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "kit" && recoveryKey) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <RecoveryKeyCard
          recoveryKey={recoveryKey}
          clipboardClearSeconds={store?.settings.clipboardClearSeconds ?? 30}
          onConfirmed={() => {
            setRecoveryKey(null); // never kept in state beyond this screen
            setStep("done");
          }}
        />
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Create your vault</Text>
        <Text style={styles.subtitle}>
          Everything is encrypted on this device with your master password. It is never sent
          anywhere — and it cannot be reset by anyone, so choose something you will remember.
        </Text>
        <Field
          label="Master password (a long passphrase is easiest to remember)"
          placeholder="e.g. five random words"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {password ? <StrengthBar strength={strength.strength} bits={strength.bits} /> : null}
        <TouchableOpacity onPress={() => setPassword(generatePassphrase())}>
          <Text style={styles.link}>Suggest a passphrase for me</Text>
        </TouchableOpacity>
        <Field
          label="Confirm master password"
          placeholder="Repeat it"
          secureTextEntry
          value={confirm}
          onChangeText={setConfirm}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <WarningBanner text="Never share your master password. If you forget it and lose your recovery key (next step), your vault may be impossible to recover." />
        <Button title="Create vault" onPress={create} busy={busy} />
        <TouchableOpacity onPress={onRestoreInstead} style={{ marginTop: spacing.lg }}>
          <Text style={[styles.link, { textAlign: "center" }]}>
            Restore from an encrypted backup instead
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingTop: 80 },
  title: { fontSize: 26, fontWeight: "700", color: colors.text, marginBottom: spacing.sm },
  subtitle: { color: colors.subtext, marginBottom: spacing.xl, lineHeight: 20 },
  link: { color: colors.primary, marginBottom: spacing.md, fontWeight: "600" },
  error: { color: colors.danger, marginBottom: spacing.md },
});

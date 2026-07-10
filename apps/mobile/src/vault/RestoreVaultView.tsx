// Restore from an encrypted .pwmbackup file (local import). Used both from onboarding
// (fresh device) and the Backup screen (replace current vault). The backup opens ONLY
// with the vault's master password or its recovery key, and integrity is validated by
// core before anything is written.
//
// Restoring via the RECOVERY KEY is treated the same as the Recover flow (see
// RecoverScreen.tsx): the store was opened without proving the master password, so
// before it is ever adopted/unlocked in the app we force the user to set a brand-new
// master password and automatically rotate the recovery key (the old one, embedded in
// the backup file, would otherwise keep working forever). Restoring with the master
// password itself already proves knowledge of the password, so that path is unchanged.
import React, { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { usePreventScreenCapture } from "expo-screen-capture";
import { VaultStore, restoreBackup, estimateStrength } from "@pw/core";
import { fileStorage } from "../storage";
import { useVault } from "./VaultContext";
import { clearStoredMasterPassword } from "../security/biometric";
import { Button, Chip, Field, StrengthBar, WarningBanner } from "../components/ui";
import { RecoveryKeyCard } from "../components/RecoveryKeyCard";
import { colors, spacing } from "../theme";

export function RestoreVaultView({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  usePreventScreenCapture("restore-vault");
  const { adoptStore, setPrefs } = useVault();
  const [backupText, setBackupText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [credKind, setCredKind] = useState<"password" | "recoveryKey">("password");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Present only when the backup was opened via recovery key and is awaiting a forced
  // master-password reset before it can be adopted.
  const [pendingStore, setPendingStore] = useState<VaultStore | null>(null);
  const [step, setStep] = useState<"pick" | "newPassword" | "rotate">("pick");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);

  const strength = useMemo(() => estimateStrength(newPassword), [newPassword]);

  const pick = async () => {
    setError("");
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    try {
      const text = await new File(res.assets[0].uri).text();
      setBackupText(text);
      setFileName(res.assets[0].name ?? "backup");
    } catch {
      setError("Could not read that file.");
    }
  };

  const restore = async () => {
    if (!backupText) return;
    setError("");
    setBusy(true);
    try {
      const cred =
        credKind === "password" ? { password: credential } : { recoveryKey: credential };
      const { vaultSerialized } = restoreBackup(backupText, cred);
      await fileStorage.save(vaultSerialized);
      const store = await VaultStore.open(vaultSerialized, cred, fileStorage);
      await store.logAndPersist("restore_completed", fileName);
      // Any biometric-cached master password may not match the restored vault.
      await clearStoredMasterPassword();
      setPrefs({ biometricEnabled: null });
      setCredential("");

      if (credKind === "recoveryKey") {
        // Opened via recovery key only — mirror RecoverScreen: force a new master
        // password before this store is ever adopted/unlocked in the app.
        setPendingStore(store);
        setStep("newPassword");
      } else {
        adoptStore(store);
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed.");
    } finally {
      setBusy(false);
    }
  };

  const setPassword = async () => {
    if (!pendingStore) return;
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
      await pendingStore.changeMasterPassword(newPassword);
      // Any biometric-cached master password is now stale — remove it.
      await clearStoredMasterPassword();
      setPrefs({ biometricEnabled: null }); // re-offer on next password unlock
      const rotated = await pendingStore.createRecoveryKey(); // the recovery key used to
      // restore this backup would otherwise still open it
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

  if (step === "rotate" && newRecoveryKey && pendingStore) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <WarningBanner text="Your master password was changed and a NEW recovery key was generated. The old recovery key no longer works." />
        <RecoveryKeyCard
          recoveryKey={newRecoveryKey}
          clipboardClearSeconds={pendingStore.settings.clipboardClearSeconds}
          onConfirmed={() => {
            setNewRecoveryKey(null);
            adoptStore(pendingStore);
            onDone();
          }}
        />
      </ScrollView>
    );
  }

  if (step === "newPassword" && pendingStore) {
    return (
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Set a new master password</Text>
          <Text style={{ color: colors.subtext, marginBottom: spacing.xl, lineHeight: 20 }}>
            This backup was unlocked with a recovery key. You must set a new master password
            before restoring it to this device.
          </Text>
          <Field
            label="New master password"
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
          />
          {newPassword ? <StrengthBar strength={strength.strength} bits={strength.bits} /> : null}
          <Field label="Confirm" secureTextEntry value={confirm} onChangeText={setConfirm} />
          {error ? <Text style={{ color: colors.danger, marginBottom: spacing.md }}>{error}</Text> : null}
          <Button title="Set new master password" onPress={() => void setPassword()} busy={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Restore from backup</Text>
        <WarningBanner text="Restoring replaces the vault on this device with the backup's contents." />
        <Button
          title={backupText ? `Selected: ${fileName}` : "Choose .pwmbackup file"}
          kind="secondary"
          onPress={() => void pick()}
        />
        {backupText ? (
          <>
            <Text style={{ color: colors.subtext, marginVertical: spacing.sm }}>
              Unlock the backup with:
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
              <Chip
                label="Master password"
                active={credKind === "password"}
                onPress={() => setCredKind("password")}
              />
              <Chip
                label="Recovery key"
                active={credKind === "recoveryKey"}
                onPress={() => setCredKind("recoveryKey")}
              />
            </ScrollView>
            <Field
              placeholder={credKind === "password" ? "Master password of the backup" : "Recovery key (ABCDE-FGHJK-…)"}
              secureTextEntry={credKind === "password"}
              autoCapitalize={credKind === "recoveryKey" ? "characters" : "none"}
              value={credential}
              onChangeText={(t) => {
                setCredential(t);
                setError("");
              }}
            />
            <Button title="Restore vault" onPress={() => void restore()} busy={busy} disabled={!credential} />
          </>
        ) : null}
        {error ? <Text style={{ color: colors.danger, marginTop: spacing.sm }}>{error}</Text> : null}
        <TouchableOpacity onPress={onCancel} style={{ marginTop: spacing.lg }}>
          <Text style={{ color: colors.primary, textAlign: "center", fontWeight: "600" }}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingTop: 60 },
  title: { fontSize: 24, fontWeight: "700", color: colors.text, marginBottom: spacing.md },
});

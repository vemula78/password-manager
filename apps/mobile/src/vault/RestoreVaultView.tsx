// Restore from an encrypted .pwmbackup file (local import). Used both from onboarding
// (fresh device) and the Backup screen (replace current vault). The backup opens ONLY
// with the vault's master password or its recovery key, and integrity is validated by
// core before anything is written.
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { VaultStore, restoreBackup } from "@pw/core";
import { fileStorage } from "../storage";
import { useVault } from "./VaultContext";
import { clearStoredMasterPassword } from "../security/biometric";
import { Button, Chip, Field, WarningBanner } from "../components/ui";
import { colors, spacing } from "../theme";

export function RestoreVaultView({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { adoptStore, setPrefs } = useVault();
  const [backupText, setBackupText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [credKind, setCredKind] = useState<"password" | "recoveryKey">("password");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      adoptStore(store);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed.");
    } finally {
      setBusy(false);
    }
  };

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

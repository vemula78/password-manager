// Backup & restore. Local encrypted export via the share sheet (the file is the core
// backup package — encrypted before it ever leaves the app sandbox), import/restore from
// a picked file, and an honest Google Drive stub (Drive OAuth on mobile is follow-up
// work; the web app has the full flow).
import React, { useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { backupFileName, createBackup } from "@pw/core";
import { useStore, useVault } from "../vault/VaultContext";
import { RestoreVaultView } from "../vault/RestoreVaultView";
import { Button, Card, SectionTitle, WarningBanner } from "../components/ui";
import { colors, spacing } from "../theme";

export function BackupScreen() {
  const store = useStore();
  const { refresh } = useVault();
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const backup = store.settings.backup;

  const exportNow = async () => {
    setBusy(true);
    let tmp: File | null = null;
    try {
      const now = new Date().toISOString();
      const pkg = createBackup(store, now); // encrypted under the Backup Key
      tmp = new File(Paths.cache, backupFileName(now));
      tmp.write(pkg);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Sharing unavailable", "This device cannot open the share sheet.");
        return;
      }
      await Sharing.shareAsync(tmp.uri, {
        mimeType: "application/octet-stream",
        dialogTitle: "Save encrypted vault backup",
      });
      await store.updateSettings({ backup: { ...backup, lastSuccessAt: now, lastError: null } });
      await store.logAndPersist("backup_completed", "local export");
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Export failed.";
      await store.updateSettings({ backup: { ...backup, lastError: msg } });
      await store.logAndPersist("backup_failed", "local export");
      Alert.alert("Backup failed", msg);
    } finally {
      // Don't leave (encrypted) backup copies lying around in cache.
      try {
        if (tmp?.exists) tmp.delete();
      } catch {
        /* best effort */
      }
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <Card>
        <Text style={styles.cardTitle}>Status</Text>
        <Text style={{ color: colors.subtext, marginTop: 4 }}>
          {backup.lastSuccessAt
            ? `Last successful backup: ${new Date(backup.lastSuccessAt).toLocaleString()}`
            : "No backup has been made yet."}
        </Text>
        {backup.lastError ? (
          <Text style={{ color: colors.danger, marginTop: 4 }}>Last error: {backup.lastError}</Text>
        ) : null}
      </Card>

      <SectionTitle>Local encrypted export</SectionTitle>
      <Card>
        <Text style={{ color: colors.subtext, marginBottom: spacing.sm }}>
          Creates a .pwmbackup file encrypted with your vault's backup key. It can be opened
          only with your master password or your recovery key. Save it to Files, AirDrop it,
          or store it on a pen drive.
        </Text>
        <Button title="Export encrypted backup" onPress={() => void exportNow()} busy={busy} />
      </Card>

      <SectionTitle>Restore</SectionTitle>
      <Card>
        <WarningBanner text="Restoring replaces this device's vault with the backup's contents." />
        <Button title="Restore from backup file" kind="secondary" onPress={() => setRestoring(true)} />
      </Card>

      <SectionTitle>Google Drive</SectionTitle>
      <Card>
        <Text style={{ color: colors.subtext, marginBottom: spacing.sm }}>
          Encrypted Google Drive backups are set up in the web app for now — Google sign-in
          inside this mobile app is follow-up work and is not available yet. Backups made
          from the web app use the same encrypted format and restore here from a downloaded
          file.
        </Text>
        <Button title="Connect Google Drive (not available yet)" kind="secondary" onPress={() => {}} disabled />
      </Card>

      <WarningBanner text="Google Drive backup is encrypted, but losing both your master password and recovery key may make recovery impossible." />

      <Modal visible={restoring} animationType="slide" onRequestClose={() => setRestoring(false)}>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <RestoreVaultView onDone={() => setRestoring(false)} onCancel={() => setRestoring(false)} />
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
});

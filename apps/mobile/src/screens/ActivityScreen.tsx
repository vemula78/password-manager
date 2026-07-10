// Local encrypted activity history (stored inside the vault by core). Detail strings
// contain item titles / short notes only — never secret values.
import React from "react";
import { Alert, FlatList, StyleSheet, Text, View } from "react-native";
import { useStore, useVault } from "../vault/VaultContext";
import { Button } from "../components/ui";
import { colors, spacing } from "../theme";

const LABELS: Record<string, string> = {
  vault_created: "Vault created",
  item_created: "Item created",
  item_edited: "Item edited",
  item_viewed: "Item viewed",
  item_deleted: "Item deleted",
  item_archived: "Item archived",
  item_restored: "Item restored",
  sensitive_revealed: "Sensitive field revealed",
  password_copied: "Password copied",
  backup_completed: "Backup completed",
  backup_failed: "Backup failed",
  restore_completed: "Restore completed",
  recovery_key_created: "Recovery key created",
  recovery_key_rotated: "Recovery key rotated",
  recovery_key_viewed: "Recovery key viewed",
  recovery_unlock: "Unlocked with recovery key",
  master_password_changed: "Master password changed",
  failed_unlock: "Failed unlock attempt",
  emergency_kit_exported: "Emergency kit exported",
  history_cleared: "History cleared",
};

export function ActivityScreen() {
  const store = useStore();
  const { refresh, tick } = useVault();
  const events = store.getAudit(); // re-read on every render; tick drives re-render
  void tick;

  const clear = () => {
    Alert.alert("Clear activity history?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => void store.clearAudit().then(refresh),
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <FlatList
        data={events}
        keyExtractor={(e, i) => `${e.at}-${i}`}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={<Text style={{ color: colors.subtext }}>No activity recorded.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={{ color: colors.text, fontWeight: "600" }}>
              {LABELS[item.type] ?? item.type}
            </Text>
            {item.detail ? <Text style={{ color: colors.subtext, fontSize: 13 }}>{item.detail}</Text> : null}
            <Text style={{ color: colors.subtext, fontSize: 12 }}>
              {new Date(item.at).toLocaleString()}
            </Text>
          </View>
        )}
      />
      <View style={{ padding: spacing.lg }}>
        <Button title="Clear history" kind="danger" onPress={clear} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
});

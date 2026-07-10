// Dashboard: health score, weak/reused counts, backup status, recent items, quick add.
import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { TEMPLATES, analyzeHealth, type ItemType } from "@pw/core";
import { useStore, useVault } from "../vault/VaultContext";
import { Button, Card, SectionTitle } from "../components/ui";
import { colors, spacing } from "../theme";
import type { ScreenProps } from "../nav";

const QUICK_ADD: ItemType[] = ["login", "netbanking", "card", "upi", "govid", "note"];

export function HomeScreen({ navigation }: ScreenProps<"Home">) {
  const store = useStore();
  const { tick, lock } = useVault();

  const items = store.listItems();
  const health = useMemo(() => analyzeHealth(items), [tick, items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const recent = [...items]
    .filter((i) => i.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
    .slice(0, 5);
  const lastBackup = store.settings.backup.lastSuccessAt;

  const scoreColor =
    health.score >= 80 ? colors.success : health.score >= 50 ? "#D98E04" : colors.danger;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View>
            <Text style={styles.cardTitle}>Password health</Text>
            <Text style={{ color: colors.subtext, marginTop: 4 }}>
              {health.weakCount} weak · {health.reusedCount} reused · {health.totalPasswords} total
            </Text>
          </View>
          <Text style={[styles.score, { color: scoreColor }]}>{health.score}</Text>
        </View>
      </Card>

      <Card>
        <Text style={styles.cardTitle}>Backup</Text>
        <Text style={{ color: lastBackup ? colors.subtext : colors.danger, marginTop: 4 }}>
          {lastBackup
            ? `Last encrypted backup: ${new Date(lastBackup).toLocaleString()}`
            : "No backup yet — export an encrypted backup soon."}
        </Text>
        <Button title="Backup & restore" kind="secondary" onPress={() => navigation.navigate("Backup")} />
      </Card>

      <SectionTitle>Quick add</SectionTitle>
      <View style={styles.quickGrid}>
        {QUICK_ADD.map((t) => (
          <TouchableOpacity
            key={t}
            style={styles.quickTile}
            onPress={() => navigation.navigate("ItemEdit", { type: t })}
          >
            <Text style={{ fontSize: 22 }}>{TEMPLATES[t].icon}</Text>
            <Text style={styles.quickLabel}>{TEMPLATES[t].label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <SectionTitle>Recently used</SectionTitle>
      {recent.length === 0 ? (
        <Text style={{ color: colors.subtext }}>Nothing used yet.</Text>
      ) : (
        recent.map((item) => (
          <TouchableOpacity
            key={item.id}
            style={styles.recentRow}
            onPress={() => navigation.navigate("ItemDetail", { id: item.id })}
          >
            <Text style={{ fontSize: 18, marginRight: spacing.sm }}>{TEMPLATES[item.type].icon}</Text>
            <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
              {item.title}
            </Text>
          </TouchableOpacity>
        ))
      )}

      <View style={{ height: spacing.lg }} />
      <Button title="All items" onPress={() => navigation.navigate("Items", { category: "all" })} />
      <Button title="Password generator" kind="secondary" onPress={() => navigation.navigate("Generator")} />
      <Button title="Settings" kind="secondary" onPress={() => navigation.navigate("Settings")} />
      <Button title="Lock now" kind="secondary" onPress={lock} />
      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  score: { fontSize: 36, fontWeight: "800" },
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  quickTile: {
    width: "31%",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  quickLabel: { fontSize: 12, color: colors.text, marginTop: 4 },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
});

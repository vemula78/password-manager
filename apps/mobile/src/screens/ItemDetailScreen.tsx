// Item detail. Sensitive fields are hidden by default; Reveal/Copy require reauth
// (biometric, falling back to master-password re-entry). Copies auto-clear from the
// clipboard. Screenshots are blocked on this screen (spec § Mobile Features).
import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { usePreventScreenCapture } from "expo-screen-capture";
import { TEMPLATES, maskValue, type FieldDef } from "@pw/core";
import { useStore, useVault } from "../vault/VaultContext";
import { copyWithAutoClear } from "../security/clipboard";
import { Button, Card, SectionTitle, WarningBanner } from "../components/ui";
import { colors, spacing } from "../theme";
import type { ScreenProps } from "../nav";

export function ItemDetailScreen({ navigation, route }: ScreenProps<"ItemDetail">) {
  usePreventScreenCapture("item-detail");
  const store = useStore();
  const { refresh, reauth } = useVault();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const item = store.getItem(route.params.id);

  useFocusEffect(
    React.useCallback(() => {
      if (item) void store.touchUsed(item.id);
      return () => setRevealed(new Set()); // re-hide on leave
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [route.params.id]),
  );

  if (!item) {
    return (
      <View style={[styles.screen, { padding: spacing.xl }]}>
        <Text style={{ color: colors.subtext }}>This item no longer exists.</Text>
      </View>
    );
  }
  const template = TEMPLATES[item.type];

  const requireReauth = async (what: string): Promise<boolean> => {
    const ok = await reauth(`Confirm it's you to ${what}`);
    if (!ok) Alert.alert("Not verified", "Reveal/copy needs biometric or master-password confirmation.");
    return ok;
  };

  const revealField = async (key: string, label: string) => {
    if (revealed.has(key)) {
      setRevealed((r) => {
        const n = new Set(r);
        n.delete(key);
        return n;
      });
      return;
    }
    if (!(await requireReauth(`reveal ${label}`))) return;
    await store.logAndPersist("sensitive_revealed", `${item.title} — ${label}`);
    setRevealed((r) => new Set(r).add(key));
    refresh();
  };

  const copyField = async (key: string, label: string, value: string, sensitive: boolean) => {
    if (sensitive && !(await requireReauth(`copy ${label}`))) return;
    await copyWithAutoClear(value, store.settings.clipboardClearSeconds);
    if (sensitive) {
      await store.logAndPersist("password_copied", `${item.title} — ${label}`);
      refresh();
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  };

  const renderValue = (def: Pick<FieldDef, "sensitive" | "masked">, key: string, value: string) => {
    if (!def.sensitive) return value;
    if (revealed.has(key)) return value;
    return def.masked ? maskValue(value) : "••••••••";
  };

  const del = () => {
    Alert.alert("Delete item?", `“${item.title}” will be permanently deleted.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void store.deleteItem(item.id).then(() => {
            refresh();
            navigation.goBack();
          });
        },
      },
    ]);
  };

  const fieldsWithValues = template.fields.filter((f) => item.fields[f.key]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.md }}>
        <Text style={{ fontSize: 28, marginRight: spacing.sm }}>{template.icon}</Text>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <TouchableOpacity
          onPress={() => {
            void store.updateItem(item.id, { favorite: !item.favorite }).then(refresh);
          }}
        >
          <Text style={{ fontSize: 24 }}>{item.favorite ? "★" : "☆"}</Text>
        </TouchableOpacity>
      </View>

      {template.warning ? <WarningBanner text={template.warning} /> : null}

      {fieldsWithValues.map((def) => {
        const value = item.fields[def.key]!;
        return (
          <Card key={def.key} style={{ paddingVertical: spacing.md }}>
            <Text style={styles.fieldLabel}>{def.label}</Text>
            <Text style={styles.fieldValue} selectable={!def.sensitive}>
              {renderValue(def, def.key, value)}
            </Text>
            {def.warning ? <Text style={styles.fieldWarning}>⚠️ {def.warning}</Text> : null}
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
              {def.sensitive ? (
                <TouchableOpacity style={styles.smallBtn} onPress={() => void revealField(def.key, def.label)}>
                  <Text style={styles.smallBtnText}>{revealed.has(def.key) ? "Hide" : "Reveal"}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.smallBtn}
                onPress={() => void copyField(def.key, def.label, value, !!def.sensitive)}
              >
                <Text style={styles.smallBtnText}>{copiedKey === def.key ? "Copied ✓" : "Copy"}</Text>
              </TouchableOpacity>
            </View>
          </Card>
        );
      })}

      {item.customFields.length > 0 ? (
        <>
          <SectionTitle>Custom fields</SectionTitle>
          {item.customFields.map((cf, idx) => {
            const key = `custom:${idx}`;
            return (
              <Card key={key} style={{ paddingVertical: spacing.md }}>
                <Text style={styles.fieldLabel}>{cf.label}</Text>
                <Text style={styles.fieldValue}>
                  {cf.sensitive && !revealed.has(key) ? "••••••••" : cf.value}
                </Text>
                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
                  {cf.sensitive ? (
                    <TouchableOpacity style={styles.smallBtn} onPress={() => void revealField(key, cf.label)}>
                      <Text style={styles.smallBtnText}>{revealed.has(key) ? "Hide" : "Reveal"}</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={styles.smallBtn}
                    onPress={() => void copyField(key, cf.label, cf.value, cf.sensitive)}
                  >
                    <Text style={styles.smallBtnText}>{copiedKey === key ? "Copied ✓" : "Copy"}</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            );
          })}
        </>
      ) : null}

      {item.notes ? (
        <>
          <SectionTitle>Notes</SectionTitle>
          <Card>
            <Text style={{ color: colors.text }}>{item.notes}</Text>
          </Card>
        </>
      ) : null}

      {item.tags.length > 0 ? (
        <Text style={{ color: colors.subtext, marginBottom: spacing.md }}>
          Tags: {item.tags.join(", ")}
        </Text>
      ) : null}

      <Button title="Edit" onPress={() => navigation.navigate("ItemEdit", { id: item.id })} />
      <Button
        title={item.archived ? "Restore from archive" : "Archive"}
        kind="secondary"
        onPress={() => {
          void store.setArchived(item.id, !item.archived).then(() => {
            refresh();
            navigation.goBack();
          });
        }}
      />
      <Button title="Delete" kind="danger" onPress={del} />
      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 22, fontWeight: "700", color: colors.text, flex: 1 },
  fieldLabel: { color: colors.subtext, fontSize: 12, marginBottom: 2 },
  fieldValue: { color: colors.text, fontSize: 16 },
  fieldWarning: { color: colors.warnText, fontSize: 12, marginTop: 4 },
  smallBtn: {
    backgroundColor: colors.chipBg,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  smallBtnText: { color: colors.primary, fontWeight: "600", fontSize: 13 },
});

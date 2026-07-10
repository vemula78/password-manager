// Add/edit an item. Fields are generated from core TEMPLATES; password fields get an
// inline "generate" action; PIN-risk and other template warnings show inline.
//
// Security note: for EXISTING items, sensitive fields (template fields with
// `sensitive: true`, and custom fields marked sensitive) are never hydrated into an
// editable/revealable input — that would let the decrypted value be toggled visible
// without reauth. Instead they render as a locked "Saved — hidden" row with "Replace"
// (swaps in an empty input for a brand-new value) and "Clear value" (explicit deletion)
// actions. Fields that are not touched keep their previous stored value on save; an
// empty "replaced" input also keeps the previous value (only "Clear value" deletes it).
// New items are unaffected — there is no previous value to protect.
import React, { useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  TEMPLATES,
  estimateStrength,
  generatePassword,
  type CustomField,
  type FieldDef,
  type ItemType,
} from "@pw/core";
import { useStore, useVault } from "../vault/VaultContext";
import { Button, Card, Field, StrengthBar, WarningBanner } from "../components/ui";
import { colors, spacing } from "../theme";
import type { ScreenProps } from "../nav";

function keyboardFor(kind: FieldDef["kind"]) {
  switch (kind) {
    case "email":
      return "email-address" as const;
    case "phone":
      return "phone-pad" as const;
    case "number":
    case "pin":
      return "number-pad" as const;
    case "url":
      return "url" as const;
    default:
      return "default" as const;
  }
}

export function ItemEditScreen({ navigation, route }: ScreenProps<"ItemEdit">) {
  const store = useStore();
  const { refresh } = useVault();
  const existing = route.params.id ? store.getItem(route.params.id) : undefined;
  const [type, setType] = useState<ItemType | null>(existing?.type ?? route.params.type ?? null);
  const [title, setTitle] = useState(existing?.title ?? "");
  const initialTemplate = existing ? TEMPLATES[existing.type] : null;

  // Sensitive template-field values from an existing item are kept out of `fields`
  // state entirely (never hydrated into a rendered input) and held here instead, only
  // to be re-attached at save time if the field isn't replaced or cleared.
  const preservedFieldsRef = useRef<Map<string, string>>(
    new Map(
      existing && initialTemplate
        ? (initialTemplate.fields
            .filter((d) => d.sensitive && existing.fields[d.key])
            .map((d) => [d.key, existing.fields[d.key] as string]) as [string, string][])
        : [],
    ),
  );
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const base = { ...(existing?.fields ?? {}) };
    if (existing && initialTemplate) {
      for (const def of initialTemplate.fields) {
        if (def.sensitive) delete base[def.key];
      }
    }
    return base;
  });
  const [replacingKeys, setReplacingKeys] = useState<Set<string>>(new Set());
  const [clearedKeys, setClearedKeys] = useState<Set<string>>(new Set());

  // Same idea for custom fields that already existed on the item: sensitive values are
  // preserved out-of-band, not put into the rendered/editable value.
  const originalCustomCount = existing?.customFields.length ?? 0;
  const preservedCustomRef = useRef<Map<number, string>>(
    new Map(
      (existing?.customFields ?? [])
        .map((c, i) => [i, c] as const)
        .filter(([, c]) => c.sensitive && c.value)
        .map(([i, c]) => [i, c.value]),
    ),
  );
  const [customFields, setCustomFields] = useState<CustomField[]>(
    (existing?.customFields ?? []).map((c, i) =>
      preservedCustomRef.current.has(i) ? { ...c, value: "" } : { ...c },
    ),
  );
  const [customReplacing, setCustomReplacing] = useState<Set<number>>(new Set());
  const [customCleared, setCustomCleared] = useState<Set<number>>(new Set());

  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [tagsText, setTagsText] = useState(existing?.tags.join(", ") ?? "");
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const template = type ? TEMPLATES[type] : null;

  const strengths = useMemo(() => {
    const out: Record<string, ReturnType<typeof estimateStrength>> = {};
    if (template) {
      for (const def of template.fields) {
        if (def.isPassword && fields[def.key]) out[def.key] = estimateStrength(fields[def.key]!);
      }
    }
    return out;
  }, [template, fields]);

  if (!type || !template) {
    // Type picker for new items.
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
        <Text style={styles.heading}>What do you want to store?</Text>
        <View style={styles.typeGrid}>
          {(Object.values(TEMPLATES) as { type: ItemType; label: string; icon: string }[]).map((t) => (
            <TouchableOpacity key={t.type} style={styles.typeTile} onPress={() => setType(t.type)}>
              <Text style={{ fontSize: 24 }}>{t.icon}</Text>
              <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    );
  }

  const startReplace = (key: string) => {
    setReplacingKeys((s) => new Set(s).add(key));
    setClearedKeys((s) => {
      if (!s.has(key)) return s;
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    setFields((f) => ({ ...f, [key]: "" }));
  };

  const clearFieldValue = (key: string) => {
    setClearedKeys((s) => new Set(s).add(key));
    setReplacingKeys((s) => {
      if (!s.has(key)) return s;
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    setFields((f) => ({ ...f, [key]: "" }));
  };

  const undoClearField = (key: string) => {
    setClearedKeys((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
  };

  const startReplaceCustom = (idx: number) => {
    setCustomReplacing((s) => new Set(s).add(idx));
    setCustomCleared((s) => {
      if (!s.has(idx)) return s;
      const n = new Set(s);
      n.delete(idx);
      return n;
    });
  };

  const clearCustomValue = (idx: number) => {
    setCustomCleared((s) => new Set(s).add(idx));
    setCustomReplacing((s) => {
      if (!s.has(idx)) return s;
      const n = new Set(s);
      n.delete(idx);
      return n;
    });
  };

  const undoClearCustom = (idx: number) => {
    setCustomCleared((s) => {
      const n = new Set(s);
      n.delete(idx);
      return n;
    });
  };

  const save = async () => {
    setError("");
    if (!title.trim()) {
      setError("Give this item a title.");
      return;
    }

    // Re-attach preserved sensitive values for fields that weren't actually replaced
    // (or were replaced but left empty) — only "Clear value" drops them.
    const fieldsForSave = { ...fields };
    if (existing && template) {
      for (const def of template.fields) {
        if (!def.sensitive) continue;
        if (clearedKeys.has(def.key)) continue;
        const typed = fieldsForSave[def.key];
        if (!typed || !typed.trim()) {
          const preserved = preservedFieldsRef.current.get(def.key);
          if (preserved !== undefined) fieldsForSave[def.key] = preserved;
        }
      }
    }
    const cleanFields = Object.fromEntries(
      Object.entries(fieldsForSave).filter(([, v]) => v.trim() !== ""),
    );

    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const customFieldsForSave = customFields.map((c, idx) => {
      if (customCleared.has(idx)) return c;
      const preserved = preservedCustomRef.current.get(idx);
      if (preserved !== undefined && c.value.trim() === "") {
        return { ...c, value: preserved };
      }
      return c;
    });
    const cleanCustom = customFieldsForSave.filter((c) => c.label.trim() && c.value.trim());

    try {
      if (existing) {
        await store.updateItem(existing.id, {
          title: title.trim(),
          fields: cleanFields,
          notes,
          tags,
          customFields: cleanCustom,
        });
      } else {
        await store.addItem({
          type,
          title: title.trim(),
          fields: cleanFields,
          notes,
          tags,
          customFields: cleanCustom,
        });
      }
      refresh();
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>
          {template.icon} {existing ? "Edit" : "New"} {template.label}
        </Text>
        {template.warning ? <WarningBanner text={template.warning} /> : null}
        <Field label="Title *" placeholder={`e.g. My ${template.label}`} value={title} onChangeText={setTitle} />

        {template.fields.map((def) => {
          const isLockedSensitive =
            !!existing && def.sensitive && preservedFieldsRef.current.has(def.key) && !replacingKeys.has(def.key);

          if (isLockedSensitive) {
            const isCleared = clearedKeys.has(def.key);
            return (
              <View key={def.key} style={styles.lockedRow}>
                <Text style={styles.label}>{def.label}</Text>
                <Text style={{ color: isCleared ? colors.danger : colors.subtext, marginBottom: spacing.sm }}>
                  {isCleared ? "Will be cleared on save" : "Saved — hidden"}
                </Text>
                <View style={{ flexDirection: "row", gap: spacing.md }}>
                  {isCleared ? (
                    <TouchableOpacity onPress={() => undoClearField(def.key)}>
                      <Text style={styles.linkSmall}>Undo</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      <TouchableOpacity onPress={() => startReplace(def.key)}>
                        <Text style={styles.linkSmall}>Replace</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => clearFieldValue(def.key)}>
                        <Text style={[styles.linkSmall, { color: colors.danger }]}>Clear value</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </View>
            );
          }

          const secure = (def.kind === "password" || def.kind === "pin") && !shown.has(def.key);
          return (
            <View key={def.key}>
              <Field
                label={def.label}
                placeholder={
                  existing && def.sensitive ? "Enter new value" : def.placeholder
                }
                value={fields[def.key] ?? ""}
                onChangeText={(v) => setFields((f) => ({ ...f, [def.key]: v }))}
                secureTextEntry={secure}
                multiline={def.kind === "multiline"}
                keyboardType={keyboardFor(def.kind)}
                style={def.kind === "multiline" ? { minHeight: 80, textAlignVertical: "top" } : undefined}
              />
              {def.warning ? <Text style={styles.inlineWarning}>⚠️ {def.warning}</Text> : null}
              {(def.kind === "password" || def.kind === "pin") && (
                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: -4, marginBottom: spacing.sm }}>
                  <TouchableOpacity
                    onPress={() =>
                      setShown((s) => {
                        const n = new Set(s);
                        if (n.has(def.key)) n.delete(def.key);
                        else n.add(def.key);
                        return n;
                      })
                    }
                  >
                    <Text style={styles.linkSmall}>{shown.has(def.key) ? "Hide" : "Show"}</Text>
                  </TouchableOpacity>
                  {def.isPassword ? (
                    <TouchableOpacity
                      onPress={() => setFields((f) => ({ ...f, [def.key]: generatePassword() }))}
                    >
                      <Text style={styles.linkSmall}>Generate strong password</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
              {strengths[def.key] ? (
                <StrengthBar strength={strengths[def.key]!.strength} bits={strengths[def.key]!.bits} />
              ) : null}
            </View>
          );
        })}

        <Field
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          style={{ minHeight: 80, textAlignVertical: "top" }}
        />
        <Field label="Tags (comma-separated)" value={tagsText} onChangeText={setTagsText} />

        <Text style={styles.subheading}>Custom fields</Text>
        {customFields.map((cf, idx) => {
          const isOriginal = idx < originalCustomCount;
          const isLockedSensitive =
            isOriginal && preservedCustomRef.current.has(idx) && !customReplacing.has(idx);

          if (isLockedSensitive) {
            const isCleared = customCleared.has(idx);
            return (
              <Card key={idx} style={{ paddingVertical: spacing.md }}>
                <Field
                  label="Label"
                  value={cf.label}
                  onChangeText={(v) =>
                    setCustomFields((list) => list.map((c, i) => (i === idx ? { ...c, label: v } : c)))
                  }
                />
                <Text style={styles.label}>Value</Text>
                <Text style={{ color: isCleared ? colors.danger : colors.subtext, marginBottom: spacing.sm }}>
                  {isCleared ? "Will be cleared on save" : "Saved — hidden"}
                </Text>
                <View style={{ flexDirection: "row", gap: spacing.md }}>
                  {isCleared ? (
                    <TouchableOpacity onPress={() => undoClearCustom(idx)}>
                      <Text style={styles.linkSmall}>Undo</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      <TouchableOpacity onPress={() => startReplaceCustom(idx)}>
                        <Text style={styles.linkSmall}>Replace</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => clearCustomValue(idx)}>
                        <Text style={[styles.linkSmall, { color: colors.danger }]}>Clear value</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity onPress={() => setCustomFields((list) => list.filter((_, i) => i !== idx))}>
                    <Text style={[styles.linkSmall, { color: colors.danger }]}>Remove</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            );
          }

          return (
            <Card key={idx} style={{ paddingVertical: spacing.md }}>
              <Field
                label="Label"
                value={cf.label}
                onChangeText={(v) =>
                  setCustomFields((list) => list.map((c, i) => (i === idx ? { ...c, label: v } : c)))
                }
              />
              <Field
                label="Value"
                placeholder={isOriginal ? "Enter new value" : undefined}
                value={cf.value}
                secureTextEntry={cf.sensitive && !shown.has(`cf:${idx}`)}
                onChangeText={(v) =>
                  setCustomFields((list) => list.map((c, i) => (i === idx ? { ...c, value: v } : c)))
                }
              />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <TouchableOpacity
                  onPress={() =>
                    setCustomFields((list) =>
                      list.map((c, i) => (i === idx ? { ...c, sensitive: !c.sensitive } : c)),
                    )
                  }
                >
                  <Text style={styles.linkSmall}>{cf.sensitive ? "Sensitive ✓" : "Mark sensitive"}</Text>
                </TouchableOpacity>
                {cf.sensitive ? (
                  <TouchableOpacity
                    onPress={() =>
                      setShown((s) => {
                        const k = `cf:${idx}`;
                        const n = new Set(s);
                        if (n.has(k)) n.delete(k);
                        else n.add(k);
                        return n;
                      })
                    }
                  >
                    <Text style={styles.linkSmall}>{shown.has(`cf:${idx}`) ? "Hide" : "Show"}</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={() => setCustomFields((list) => list.filter((_, i) => i !== idx))}>
                  <Text style={[styles.linkSmall, { color: colors.danger }]}>Remove</Text>
                </TouchableOpacity>
              </View>
            </Card>
          );
        })}
        <Button
          title="+ Add custom field"
          kind="secondary"
          onPress={() => setCustomFields((list) => [...list, { label: "", value: "", sensitive: false }])}
        />

        {error ? <Text style={{ color: colors.danger, marginVertical: spacing.sm }}>{error}</Text> : null}
        <Button title={existing ? "Save changes" : "Save"} onPress={() => void save()} />
        <Button title="Cancel" kind="secondary" onPress={() => navigation.goBack()} />
        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  heading: { fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: spacing.md },
  subheading: { fontSize: 16, fontWeight: "700", color: colors.text, marginVertical: spacing.sm },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  typeTile: {
    width: "31%",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: spacing.lg,
    marginBottom: spacing.sm,
  },
  inlineWarning: { color: colors.warnText, fontSize: 12, marginTop: -8, marginBottom: spacing.sm },
  linkSmall: { color: colors.primary, fontSize: 13, fontWeight: "600" },
  label: { color: colors.subtext, fontSize: 13, marginBottom: 4 },
  lockedRow: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
});

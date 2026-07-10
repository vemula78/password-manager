// Item list: search (core's metadata-only search — sensitive values excluded), category
// filter chips, favorites filter, add button.
import React, { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { TEMPLATES, type ItemType, type VaultItem } from "@pw/core";
import { useStore, useVault } from "../vault/VaultContext";
import { Chip, Field } from "../components/ui";
import { colors, spacing } from "../theme";
import type { CategoryKey, ScreenProps } from "../nav";

const CATEGORIES: { key: CategoryKey; label: string; types: ItemType[] | null }[] = [
  { key: "all", label: "All", types: null },
  { key: "banking", label: "Banking", types: ["netbanking", "demat"] },
  { key: "cards", label: "Cards", types: ["card"] },
  { key: "upi", label: "UPI", types: ["upi"] },
  { key: "govids", label: "Gov IDs", types: ["govid"] },
  { key: "notes", label: "Notes", types: ["note"] },
];

export function ItemsScreen({ navigation, route }: ScreenProps<"Items">) {
  const store = useStore();
  const { tick } = useVault();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryKey>(route.params?.category ?? "all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const items = useMemo(() => {
    let list: VaultItem[] = store.search(query);
    const cat = CATEGORIES.find((c) => c.key === category);
    if (cat?.types) list = list.filter((i) => cat.types!.includes(i.type));
    if (favoritesOnly) list = list.filter((i) => i.favorite);
    return list.sort((a, b) => a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, query, category, favoritesOnly, tick]);

  return (
    <View style={styles.screen}>
      <View style={{ padding: spacing.lg, paddingBottom: 0 }}>
        <Field placeholder="Search titles, tags, non-sensitive fields…" value={query} onChangeText={setQuery} />
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {CATEGORIES.map((c) => (
            <Chip key={c.key} label={c.label} active={category === c.key} onPress={() => setCategory(c.key)} />
          ))}
          <Chip label="★ Favorites" active={favoritesOnly} onPress={() => setFavoritesOnly((f) => !f)} />
        </View>
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          <Text style={{ color: colors.subtext, textAlign: "center", marginTop: spacing.xl }}>
            No items yet. Tap “+ Add” to create one.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => navigation.navigate("ItemDetail", { id: item.id })}
          >
            <Text style={{ fontSize: 20, marginRight: spacing.md }}>{TEMPLATES[item.type].icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
                {item.favorite ? "★ " : ""}
                {item.title}
              </Text>
              <Text style={{ color: colors.subtext, fontSize: 13 }}>{TEMPLATES[item.type].label}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate("ItemEdit", {})}>
        <Text style={{ color: colors.primaryText, fontSize: 16, fontWeight: "700" }}>+ Add</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  fab: {
    position: "absolute",
    right: spacing.xl,
    bottom: spacing.xl,
    backgroundColor: colors.primary,
    borderRadius: 24,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
});

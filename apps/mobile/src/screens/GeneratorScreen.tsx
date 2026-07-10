// Password & passphrase generator — all randomness from core (libsodium CSPRNG).
import React, { useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  estimateStrength,
  generatePassphrase,
  generatePassword,
  type PassphraseOptions,
  type PasswordOptions,
} from "@pw/core";
import { useStore } from "../vault/VaultContext";
import { Button, Card, Chip, StrengthBar } from "../components/ui";
import { copyWithAutoClear } from "../security/clipboard";
import { colors, spacing } from "../theme";

export function GeneratorScreen() {
  const store = useStore();
  const [mode, setMode] = useState<"password" | "passphrase">("password");
  const [pwOpts, setPwOpts] = useState<PasswordOptions>({ ...DEFAULT_PASSWORD_OPTIONS });
  const [ppOpts, setPpOpts] = useState<PassphraseOptions>({ ...DEFAULT_PASSPHRASE_OPTIONS });
  const [value, setValue] = useState(() => generatePassword(DEFAULT_PASSWORD_OPTIONS));
  const [copied, setCopied] = useState(false);

  const regen = (m = mode, pw = pwOpts, pp = ppOpts) => {
    setCopied(false);
    setValue(m === "password" ? generatePassword(pw) : generatePassphrase(pp));
  };

  const strength = estimateStrength(value);

  const toggleRow = (label: string, key: keyof PasswordOptions) => (
    <View style={styles.toggleRow} key={key}>
      <Text style={{ color: colors.text }}>{label}</Text>
      <Switch
        value={!!pwOpts[key]}
        onValueChange={(v) => {
          const next = { ...pwOpts, [key]: v };
          setPwOpts(next);
          regen("password", next);
        }}
      />
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <View style={{ flexDirection: "row", marginBottom: spacing.md }}>
        <Chip label="Password" active={mode === "password"} onPress={() => { setMode("password"); regen("password"); }} />
        <Chip label="Passphrase" active={mode === "passphrase"} onPress={() => { setMode("passphrase"); regen("passphrase"); }} />
      </View>

      <Card>
        <Text style={styles.value} selectable>
          {value}
        </Text>
        <StrengthBar strength={strength.strength} bits={strength.bits} />
        <Button title="Regenerate" kind="secondary" onPress={() => regen()} />
        <Button
          title={copied ? "Copied (auto-clears) ✓" : "Copy"}
          onPress={() => {
            void copyWithAutoClear(value, store.settings.clipboardClearSeconds);
            setCopied(true);
          }}
        />
      </Card>

      {mode === "password" ? (
        <Card>
          <View style={styles.toggleRow}>
            <Text style={{ color: colors.text }}>Length: {pwOpts.length}</Text>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              {[12, 16, 20, 24, 32].map((n) => (
                <TouchableOpacity
                  key={n}
                  onPress={() => {
                    const next = { ...pwOpts, length: n };
                    setPwOpts(next);
                    regen("password", next);
                  }}
                >
                  <Text style={{ color: pwOpts.length === n ? colors.primary : colors.subtext, fontWeight: "700" }}>
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {toggleRow("Lowercase (a-z)", "lower")}
          {toggleRow("Uppercase (A-Z)", "upper")}
          {toggleRow("Digits (0-9)", "digits")}
          {toggleRow("Symbols (!@#…)", "symbols")}
          {toggleRow("Exclude look-alikes (0O1lI)", "excludeAmbiguous")}
        </Card>
      ) : (
        <Card>
          <View style={styles.toggleRow}>
            <Text style={{ color: colors.text }}>Words: {ppOpts.words}</Text>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              {[4, 5, 6, 7].map((n) => (
                <TouchableOpacity
                  key={n}
                  onPress={() => {
                    const next = { ...ppOpts, words: n };
                    setPpOpts(next);
                    regen("passphrase", pwOpts, next);
                  }}
                >
                  <Text style={{ color: ppOpts.words === n ? colors.primary : colors.subtext, fontWeight: "700" }}>
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={styles.toggleRow}>
            <Text style={{ color: colors.text }}>Capitalize words</Text>
            <Switch
              value={ppOpts.capitalize}
              onValueChange={(v) => {
                const next = { ...ppOpts, capitalize: v };
                setPpOpts(next);
                regen("passphrase", pwOpts, next);
              }}
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={{ color: colors.text }}>Include a number</Text>
            <Switch
              value={ppOpts.includeNumber}
              onValueChange={(v) => {
                const next = { ...ppOpts, includeNumber: v };
                setPpOpts(next);
                regen("passphrase", pwOpts, next);
              }}
            />
          </View>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  value: {
    fontFamily: "Courier",
    fontSize: 18,
    color: colors.text,
    marginBottom: spacing.md,
    textAlign: "center",
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
  },
});

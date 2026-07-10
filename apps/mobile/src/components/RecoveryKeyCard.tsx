// One-time display of a freshly generated recovery key, with copy / share-as-text and a
// mandatory "I have stored it safely" confirmation. Screenshots are blocked while visible.
import React, { useState } from "react";
import { Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { usePreventScreenCapture } from "expo-screen-capture";
import { Button, WarningBanner } from "./ui";
import { copyWithAutoClear } from "../security/clipboard";
import { colors, spacing } from "../theme";

export function RecoveryKeyCard({
  recoveryKey,
  onConfirmed,
  clipboardClearSeconds,
}: {
  recoveryKey: string;
  onConfirmed: () => void;
  clipboardClearSeconds: number;
}) {
  usePreventScreenCapture("recovery-key");
  const [checked, setChecked] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <View>
      <Text style={styles.heading}>Your recovery key</Text>
      <Text style={styles.body}>
        This key is shown only once. It is the ONLY way back into your vault if you forget
        your master password.
      </Text>
      <View style={styles.keyBox}>
        <Text style={styles.keyText} selectable>
          {recoveryKey}
        </Text>
      </View>
      <Button
        title={copied ? "Copied (clipboard will auto-clear)" : "Copy"}
        kind="secondary"
        onPress={() => {
          void copyWithAutoClear(recoveryKey, clipboardClearSeconds);
          setCopied(true);
        }}
      />
      <Button
        title="Share as text (to print / save offline)"
        kind="secondary"
        onPress={() => {
          void Share.share({
            message: `Password Vault recovery key (store offline, never inside the vault):\n\n${recoveryKey}`,
          });
        }}
      />
      <WarningBanner text="If you forget your master password AND lose this recovery key, your encrypted vault may be impossible to recover. Nobody — not the app, not Google — can decrypt it for you. Store this key outside the vault, preferably printed and kept safely." />
      <TouchableOpacity style={styles.checkboxRow} onPress={() => setChecked((c) => !c)}>
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked ? <Text style={{ color: "#fff", fontSize: 12 }}>✓</Text> : null}
        </View>
        <Text style={{ color: colors.text, flex: 1 }}>
          I have written down or safely stored this recovery key.
        </Text>
      </TouchableOpacity>
      <Button title="Continue" onPress={onConfirmed} disabled={!checked} />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: spacing.sm },
  body: { color: colors.subtext, marginBottom: spacing.md, lineHeight: 20 },
  keyBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  keyText: {
    fontSize: 18,
    fontFamily: "Courier",
    color: colors.text,
    textAlign: "center",
    letterSpacing: 1,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: spacing.md,
    gap: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.subtext,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
});

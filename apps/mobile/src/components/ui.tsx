// Small shared UI primitives — kept deliberately plain.
import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";
import type { Strength } from "@pw/core";
import { colors, spacing } from "../theme";

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  busy,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
}) {
  const bg =
    kind === "primary" ? colors.primary : kind === "danger" ? colors.danger : colors.chipBg;
  const fg = kind === "secondary" ? colors.text : colors.primaryText;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={[styles.button, { backgroundColor: bg, opacity: disabled || busy ? 0.5 : 1 }]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontWeight: "600", fontSize: 16 }}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.subtext}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
        style={[styles.input, style]}
      />
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function WarningBanner({ text }: { text: string }) {
  return (
    <View style={styles.warning}>
      <Text style={{ color: colors.warnText, fontSize: 13 }}>⚠️ {text}</Text>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? colors.chipActive : colors.chipBg }]}
    >
      <Text style={{ color: active ? colors.primaryText : colors.text, fontSize: 13 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const STRENGTH_META: Record<Strength, { label: string; color: string; frac: number }> = {
  "very-weak": { label: "Very weak", color: colors.danger, frac: 0.15 },
  weak: { label: "Weak", color: "#D98E04", frac: 0.4 },
  fair: { label: "Fair", color: "#C9B002", frac: 0.7 },
  strong: { label: "Strong", color: colors.success, frac: 1 },
};

export function StrengthBar({ strength, bits }: { strength: Strength; bits: number }) {
  const meta = STRENGTH_META[strength];
  return (
    <View style={{ marginBottom: spacing.md }}>
      <View style={styles.strengthTrack}>
        <View
          style={[styles.strengthFill, { width: `${meta.frac * 100}%`, backgroundColor: meta.color }]}
        />
      </View>
      <Text style={{ color: meta.color, fontSize: 12, marginTop: 2 }}>
        {meta.label} (~{bits} bits)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: 10,
    alignItems: "center",
    marginVertical: spacing.xs,
  },
  label: { color: colors.subtext, fontSize: 13, marginBottom: 4 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.subtext,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  warning: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  strengthTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.chipBg,
    overflow: "hidden",
  },
  strengthFill: { height: 6, borderRadius: 3 },
});

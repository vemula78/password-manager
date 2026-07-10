// Settings: change master password, rotate recovery key (reauth first), biometric
// toggle, clipboard timeout, auto-lock / background grace, activity history, lock now.
import React, { useEffect, useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { estimateStrength, hasRecovery, verifyMasterPassword } from "@pw/core";
import { useStore, useVault } from "../vault/VaultContext";
import { biometricLabel, biometricsAvailable } from "../security/biometric";
import { Button, Card, Field, SectionTitle, StrengthBar, WarningBanner } from "../components/ui";
import { RecoveryKeyCard } from "../components/RecoveryKeyCard";
import { colors, spacing } from "../theme";
import type { ScreenProps } from "../nav";

function OptionRow({ label, options, value, onChange, fmt }: {
  label: string;
  options: number[];
  value: number;
  onChange: (n: number) => void;
  fmt: (n: number) => string;
}) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={{ color: colors.text, marginBottom: spacing.xs }}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {options.map((n) => (
          <TouchableOpacity
            key={n}
            onPress={() => onChange(n)}
            style={[styles.option, value === n && styles.optionActive]}
          >
            <Text style={{ color: value === n ? colors.primaryText : colors.text, fontSize: 13 }}>
              {fmt(n)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export function SettingsScreen({ navigation }: ScreenProps<"Settings">) {
  const store = useStore();
  const { lock, prefs, setPrefs, reauth, reauthPassword, refresh, enableBiometrics, disableBiometrics } = useVault();
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLabel, setBioLabel] = useState("Biometric unlock");

  // Change-password modal state.
  const [changingPw, setChangingPw] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  // Biometric-enable modal (needs the master password to store it).
  const [enablingBio, setEnablingBio] = useState(false);
  const [bioPw, setBioPw] = useState("");
  const [bioError, setBioError] = useState("");

  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const avail = await biometricsAvailable();
      setBioAvailable(avail);
      if (avail) setBioLabel(await biometricLabel());
    })();
  }, []);

  const changePassword = async () => {
    setPwError("");
    if (!verifyMasterPassword(store.getHeader(), currentPw)) {
      setPwError("Current master password is incorrect.");
      return;
    }
    if (newPw.length < 8) {
      setPwError("Use at least 8 characters — a long passphrase is best.");
      return;
    }
    if (newPw !== confirmPw) {
      setPwError("New passwords do not match.");
      return;
    }
    setPwBusy(true);
    try {
      await store.changeMasterPassword(newPw, { masterPassword: currentPw });
      if (prefs.biometricEnabled) await enableBiometrics(newPw); // refresh cached credential
      setChangingPw(false);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      refresh();
      Alert.alert("Done", "Master password changed.");
    } catch (e) {
      setPwError(e instanceof Error ? e.message : "Could not change the password.");
    } finally {
      setPwBusy(false);
    }
  };

  const rotateRecoveryKey = async () => {
    // Core requires the verified master password itself for recovery changes.
    const pw = await reauthPassword("rotate your recovery key");
    if (!pw) return;
    const key = await store.createRecoveryKey({ masterPassword: pw });
    refresh();
    setRotatedKey(key);
  };

  const toggleBiometrics = async (on: boolean) => {
    if (on) {
      setBioPw("");
      setBioError("");
      setEnablingBio(true);
    } else {
      await disableBiometrics();
    }
  };

  const confirmEnableBio = async () => {
    if (!verifyMasterPassword(store.getHeader(), bioPw)) {
      setBioError("Incorrect master password.");
      return;
    }
    await enableBiometrics(bioPw);
    setBioPw("");
    setEnablingBio(false);
  };

  const newStrength = estimateStrength(newPw);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <SectionTitle>Security</SectionTitle>
      <Card>
        <Button title="Change master password" kind="secondary" onPress={() => setChangingPw(true)} />
        <Button
          title={hasRecovery(store.getHeader()) ? "Rotate recovery key" : "Create recovery key"}
          kind="secondary"
          onPress={() => void rotateRecoveryKey()}
        />
        {bioAvailable ? (
          <View style={styles.switchRow}>
            <Text style={{ color: colors.text, flex: 1 }}>{bioLabel} unlock</Text>
            <Switch value={!!prefs.biometricEnabled} onValueChange={(v) => void toggleBiometrics(v)} />
          </View>
        ) : (
          <Text style={{ color: colors.subtext, marginTop: spacing.sm }}>
            Biometric unlock is unavailable (no hardware or nothing enrolled).
          </Text>
        )}
      </Card>

      <SectionTitle>Locking & clipboard</SectionTitle>
      <Card>
        <OptionRow
          label="Clear clipboard after"
          options={[15, 30, 60, 120]}
          value={store.settings.clipboardClearSeconds}
          fmt={(n) => `${n}s`}
          onChange={(n) => {
            void store.updateSettings({ clipboardClearSeconds: n }).then(refresh);
          }}
        />
        <OptionRow
          label="Lock when app goes to background"
          options={[0, 15, 60, 300]}
          value={prefs.backgroundGraceSeconds}
          fmt={(n) => (n === 0 ? "Immediately" : n < 60 ? `After ${n}s` : `After ${n / 60} min`)}
          onChange={(n) => setPrefs({ backgroundGraceSeconds: n })}
        />
        <OptionRow
          label="Auto-lock while open"
          options={[1, 5, 15, 30]}
          value={store.settings.autoLockMinutes}
          fmt={(n) => `${n} min`}
          onChange={(n) => {
            void store.updateSettings({ autoLockMinutes: n }).then(refresh);
          }}
        />
      </Card>

      <SectionTitle>Activity</SectionTitle>
      <Card>
        <Button title="View activity history" kind="secondary" onPress={() => navigation.navigate("Activity")} />
      </Card>

      <Button title="Lock now" kind="danger" onPress={lock} />
      <View style={{ height: spacing.xl }} />

      {/* Change master password */}
      <Modal visible={changingPw} animationType="slide" transparent onRequestClose={() => setChangingPw(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Change master password</Text>
            <Field label="Current master password" secureTextEntry value={currentPw} onChangeText={setCurrentPw} />
            <Field label="New master password" secureTextEntry value={newPw} onChangeText={setNewPw} />
            {newPw ? <StrengthBar strength={newStrength.strength} bits={newStrength.bits} /> : null}
            <Field label="Confirm new password" secureTextEntry value={confirmPw} onChangeText={setConfirmPw} />
            {pwError ? <Text style={{ color: colors.danger, marginBottom: spacing.sm }}>{pwError}</Text> : null}
            <Button title="Change password" onPress={() => void changePassword()} busy={pwBusy} />
            <Button title="Cancel" kind="secondary" onPress={() => setChangingPw(false)} />
          </View>
        </View>
      </Modal>

      {/* Enable biometrics (needs master password to cache it) */}
      <Modal visible={enablingBio} animationType="fade" transparent onRequestClose={() => setEnablingBio(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Enable {bioLabel} unlock</Text>
            <Text style={{ color: colors.subtext, marginBottom: spacing.md }}>
              Your master password will be stored in the device's secure keychain, readable
              only after {bioLabel}. Confirm it to continue.
            </Text>
            <Field placeholder="Master password" secureTextEntry value={bioPw} onChangeText={(t) => { setBioPw(t); setBioError(""); }} />
            {bioError ? <Text style={{ color: colors.danger, marginBottom: spacing.sm }}>{bioError}</Text> : null}
            <Button title="Enable" onPress={() => void confirmEnableBio()} disabled={!bioPw} />
            <Button title="Cancel" kind="secondary" onPress={() => setEnablingBio(false)} />
          </View>
        </View>
      </Modal>

      {/* One-time display of a rotated recovery key */}
      <Modal visible={rotatedKey !== null} animationType="slide" onRequestClose={() => {}}>
        <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.xl, paddingTop: 60 }}>
          <WarningBanner text="Your previous recovery key no longer works. Replace it in your emergency kit." />
          {rotatedKey ? (
            <RecoveryKeyCard
              recoveryKey={rotatedKey}
              clipboardClearSeconds={store.settings.clipboardClearSeconds}
              onConfirmed={() => setRotatedKey(null)}
            />
          ) : null}
        </ScrollView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  switchRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.md },
  option: {
    backgroundColor: colors.chipBg,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  optionActive: { backgroundColor: colors.primary },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalCard: { backgroundColor: colors.card, borderRadius: 12, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: spacing.md },
});

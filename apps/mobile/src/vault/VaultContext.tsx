// App-wide vault state. Holds the unlocked VaultStore in memory only; locking drops keys
// (core wipes them). Implements SPEC § Mobile Features "App lock on background": an
// AppState listener locks immediately when the app leaves the foreground unless the
// user-configured grace period applies.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Modal, StyleSheet, Text, View } from "react-native";
import {
  VaultStore,
  WrongCredentialError,
  verifyMasterPassword,
} from "@pw/core";
import { initSodium } from "../sodiumProvider";
import {
  DevicePrefs,
  fileStorage,
  readPrefs,
  readVault,
  vaultExists,
  writePrefs,
} from "../storage";
import {
  biometricsAvailable,
  clearStoredMasterPassword,
  promptBiometric,
  readMasterPassword,
  storeMasterPassword,
} from "../security/biometric";
import { Button, Field } from "../components/ui";
import { colors, spacing } from "../theme";

export type VaultStatus = "loading" | "none" | "locked" | "unlocked";

interface VaultContextValue {
  status: VaultStatus;
  store: VaultStore | null;
  /** Bumps on every mutation so screens re-render. */
  tick: number;
  refresh: () => void;
  prefs: DevicePrefs;
  setPrefs: (p: Partial<DevicePrefs>) => void;
  createVault: (masterPassword: string) => Promise<VaultStore>;
  unlockWithPassword: (password: string) => Promise<void>;
  unlockWithRecoveryKey: (recoveryKey: string) => Promise<VaultStore>;
  unlockWithBiometrics: () => Promise<boolean>;
  lock: () => void;
  /** Replace the in-memory store after a restore-from-backup. */
  adoptStore: (store: VaultStore) => void;
  enableBiometrics: (masterPassword: string) => Promise<void>;
  disableBiometrics: () => Promise<void>;
  /** Reauth gate for reveal/copy/recovery changes: biometric, else master password. */
  reauth: (reason: string) => Promise<boolean>;
  reauthPassword: (reason: string) => Promise<string | null>;
}

const Ctx = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside provider");
  return v;
}

/** The unlocked store, for screens that only render when unlocked. */
export function useStore(): VaultStore {
  const { store } = useVault();
  if (!store) throw new Error("Vault is locked");
  return store;
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [store, setStore] = useState<VaultStore | null>(null);
  const [tick, setTick] = useState(0);
  const [prefs, setPrefsState] = useState<DevicePrefs>(readPrefs);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Master-password fallback prompt (used by reauth when biometrics are unavailable).
  const [pwPrompt, setPwPrompt] = useState<{ reason: string; resolve: (password: string | null) => void } | null>(null);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");

  useEffect(() => {
    void (async () => {
      await initSodium();
      setStatus(vaultExists() ? "locked" : "none");
    })();
  }, []);

  const lock = useCallback(() => {
    setStore((s) => {
      s?.lock(); // wipes VK/BK
      return null;
    });
    setStatus((st) => (st === "unlocked" ? "locked" : st));
  }, []);

  // App lock on background (immediate unless a grace period is configured).
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    if (status !== "unlocked") return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "inactive") {
        if (prefs.backgroundGraceSeconds <= 0) lock();
        else backgroundedAt.current = Date.now();
      } else if (next === "active" && backgroundedAt.current !== null) {
        const away = (Date.now() - backgroundedAt.current) / 1000;
        backgroundedAt.current = null;
        if (away >= prefs.backgroundGraceSeconds) lock();
      }
    });
    return () => sub.remove();
  }, [status, prefs.backgroundGraceSeconds, lock]);

  // Idle auto-lock while in the foreground (settings.autoLockMinutes from core settings).
  useEffect(() => {
    if (status !== "unlocked" || !store) return;
    const minutes = store.settings.autoLockMinutes;
    if (!minutes || minutes <= 0) return;
    const timer = setTimeout(lock, minutes * 60 * 1000);
    return () => clearTimeout(timer); // any re-render tick resets via deps below
  }, [status, store, tick, lock]);

  const setPrefs = useCallback((p: Partial<DevicePrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...p };
      writePrefs(next);
      return next;
    });
  }, []);

  const createVault = useCallback(async (masterPassword: string) => {
    const s = await VaultStore.create(masterPassword, fileStorage);
    setStore(s);
    setStatus("unlocked");
    return s;
  }, []);

  const unlockWithPassword = useCallback(async (password: string) => {
    const s = await VaultStore.open(readVault(), { password }, fileStorage);
    setStore(s);
    setStatus("unlocked");
  }, []);

  const unlockWithRecoveryKey = useCallback(async (recoveryKey: string) => {
    const s = await VaultStore.open(readVault(), { recoveryKey }, fileStorage);
    setStore(s);
    setStatus("unlocked");
    return s;
  }, []);

  const unlockWithBiometrics = useCallback(async (): Promise<boolean> => {
    // The SecureStore read triggers the OS biometric prompt itself.
    const pw = await readMasterPassword();
    if (pw == null) return false;
    try {
      await unlockWithPassword(pw);
      return true;
    } catch (e) {
      if (e instanceof WrongCredentialError) {
        // Master password changed elsewhere — stored credential is stale. Remove it.
        await clearStoredMasterPassword();
        setPrefs({ biometricEnabled: false });
      }
      return false;
    }
  }, [unlockWithPassword, setPrefs]);

  const adoptStore = useCallback((s: VaultStore) => {
    setStore((old) => {
      if (old && old !== s) old.lock();
      return s;
    });
    setStatus("unlocked");
  }, []);

  const enableBiometrics = useCallback(
    async (masterPassword: string) => {
      await storeMasterPassword(masterPassword);
      setPrefs({ biometricEnabled: true });
    },
    [setPrefs],
  );

  const disableBiometrics = useCallback(async () => {
    await clearStoredMasterPassword();
    setPrefs({ biometricEnabled: false });
  }, [setPrefs]);

  const reauth = useCallback(
    async (reason: string): Promise<boolean> => {
      if (await biometricsAvailable()) {
        return promptBiometric(reason);
      }
      // Fall back to master-password re-entry.
      return new Promise<boolean>((resolve) => {
        setPwInput("");
        setPwError("");
        setPwPrompt({ reason, resolve: (password) => resolve(password !== null) });
      });
    },
    [],
  );

  /**
   * Like reauth, but returns the verified master password itself — required by core for
   * recovery-key changes and master-password changes (core-enforced reauthentication).
   * Biometric path: the SecureStore read is itself biometric-gated, so a successful read
   * IS the biometric confirmation. Falls back to the master-password modal.
   */
  const reauthPassword = useCallback(
    async (reason: string): Promise<string | null> => {
      if (prefs.biometricEnabled) {
        try {
          const pw = await readMasterPassword();
          if (pw && store && verifyMasterPassword(store.getHeader(), pw)) return pw;
        } catch {
          // user cancelled or keychain unavailable — fall through to the modal
        }
      }
      return new Promise<string | null>((resolve) => {
        setPwInput("");
        setPwError("");
        setPwPrompt({ reason, resolve });
      });
    },
    [prefs.biometricEnabled, store],
  );

  const submitPwPrompt = useCallback(() => {
    if (!pwPrompt || !store) return;
    if (verifyMasterPassword(store.getHeader(), pwInput)) {
      pwPrompt.resolve(pwInput);
      setPwPrompt(null);
      setPwInput("");
    } else {
      setPwError("Incorrect master password.");
    }
  }, [pwPrompt, store, pwInput]);

  const cancelPwPrompt = useCallback(() => {
    pwPrompt?.resolve(null);
    setPwPrompt(null);
    setPwInput("");
  }, [pwPrompt]);

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      store,
      tick,
      refresh,
      prefs,
      setPrefs,
      createVault,
      unlockWithPassword,
      unlockWithRecoveryKey,
      unlockWithBiometrics,
      lock,
      adoptStore,
      enableBiometrics,
      disableBiometrics,
      reauth,
      reauthPassword,
    }),
    [status, store, tick, refresh, prefs, setPrefs, createVault, unlockWithPassword,
     unlockWithRecoveryKey, unlockWithBiometrics, lock, adoptStore, enableBiometrics,
     disableBiometrics, reauth, reauthPassword],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal visible={pwPrompt !== null} transparent animationType="fade" onRequestClose={cancelPwPrompt}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm master password</Text>
            <Text style={{ color: colors.subtext, marginBottom: spacing.md }}>
              {pwPrompt?.reason}
            </Text>
            <Field
              placeholder="Master password"
              secureTextEntry
              value={pwInput}
              onChangeText={(t) => {
                setPwInput(t);
                setPwError("");
              }}
              autoFocus
            />
            {pwError ? <Text style={{ color: colors.danger, marginBottom: spacing.sm }}>{pwError}</Text> : null}
            <Button title="Confirm" onPress={submitPwPrompt} />
            <Button title="Cancel" kind="secondary" onPress={cancelPwPrompt} />
          </View>
        </View>
      </Modal>
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: spacing.xl,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: spacing.lg,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: spacing.sm },
});

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
import { deriveAuthToken } from "@pw/sync";
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
  deleteSharedVaultKey,
  promptBiometric,
  readMasterPassword,
  storeMasterPassword,
  storeSharedVaultKey,
} from "../security/biometric";
import { syncCredentialIdentities, clearCredentialIdentities } from "../security/identitySync";
import { loadSyncConfig, saveSyncConfig, type SyncIdentity } from "../sync/config";
import { useSync, type SyncStatus } from "../sync/useSync";
import { Button, Field } from "../components/ui";
import { colors, spacing } from "../theme";

/** Placeholder identity used only until initSodium() has run — randomId() needs sodium. */
const PLACEHOLDER_IDENTITY: SyncIdentity = {
  deviceId: "",
  deviceLabel: "",
  sync: {
    enabled: false,
    serverUrl: "",
    accountId: "",
    lastSyncRev: 0,
    highestSeenRev: 0,
    lastHeaderRev: 0,
    lastSyncAt: null,
    lastError: null,
  },
};

export type VaultStatus = "loading" | "none" | "locked" | "unlocked" | "error";

interface VaultContextValue {
  status: VaultStatus;
  /** Set when status === "error" (e.g. a misconfigured build can't resolve vault storage). */
  errorMessage: string | null;
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

  // ---- multi-device sync (SYNC-DESIGN.md) ----
  syncIdentity: SyncIdentity;
  updateSyncConfig: (patch: Partial<SyncIdentity["sync"]>) => void;
  /**
   * Derived at unlock — the one moment the master password is legitimately in hand — and
   * held in memory only. Never persisted. Cleared on lock.
   */
  authTokenB64: string | null;
  syncStatus: SyncStatus;
  syncNow: (opts?: { silent?: boolean }) => Promise<void>;
  /**
   * Rotate the sync server's header and auth verifier after a master-password change.
   * Resolves to null when sync is off; throws when the server could not be updated, which
   * the caller must surface — the old password keeps working against the server until it
   * succeeds.
   */
  pushSyncHeader: (newMasterPassword: string) => Promise<void | null>;
  /**
   * Register the server-side recovery verifier after creating or rotating the recovery key.
   * Resolves to null when sync is off; throws when the server could not be updated.
   */
  pushSyncRecoveryVerifier: (recoveryKeyText: string) => Promise<void | null>;
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [store, setStore] = useState<VaultStore | null>(null);
  const [tick, setTick] = useState(0);
  const [prefs, setPrefsState] = useState<DevicePrefs>(readPrefs);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ---- multi-device sync state ----
  const [syncIdentity, setSyncIdentity] = useState<SyncIdentity>(PLACEHOLDER_IDENTITY);
  const [authTokenB64, setAuthTokenB64] = useState<string | null>(null);

  const updateSyncConfig = useCallback((patch: Partial<SyncIdentity["sync"]>) => {
    setSyncIdentity((prev) => {
      const next = { ...prev, sync: { ...prev.sync, ...patch } };
      saveSyncConfig(next);
      return next;
    });
  }, []);

  // Master-password fallback prompt (used by reauth when biometrics are unavailable).
  const [pwPrompt, setPwPrompt] = useState<{ reason: string; resolve: (password: string | null) => void } | null>(null);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");

  useEffect(() => {
    void (async () => {
      await initSodium();
      // randomId() (used to mint a device id on first run) needs sodium initialized, so the
      // sync identity can only be loaded after this point.
      setSyncIdentity(loadSyncConfig());
      try {
        setStatus(vaultExists() ? "locked" : "none");
      } catch (e) {
        // e.g. VaultStorageUnavailableError on iOS — a misconfigured build can't resolve the
        // App Group container. Surface loudly rather than silently falling back to stale data.
        setErrorMessage(e instanceof Error ? e.message : "Vault storage is unavailable.");
        setStatus("error");
      }
    })();
  }, []);

  // iOS QuickType bar sync: re-populate ASCredentialIdentityStore whenever the unlocked store
  // changes (fresh unlock/create/restore) or the item list changes (every add/edit/delete/
  // archive calls refresh(), which bumps `tick`). Only runs when the user has actually opted
  // into biometrics/AutoFill — see identitySync.ts and disableBiometrics below for the
  // opt-out/clear path. No-op on Android/web.
  useEffect(() => {
    if (status === "unlocked" && store && prefs.biometricEnabled === true) {
      void syncCredentialIdentities(store);
    }
  }, [status, store, tick, prefs.biometricEnabled]);

  const lock = useCallback(() => {
    setStore((s) => {
      s?.lock(); // wipes VK/BK
      return null;
    });
    setAuthTokenB64(null); // never held past the unlocked session
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

  const createVault = useCallback(
    async (masterPassword: string) => {
      const s = await VaultStore.create(masterPassword, fileStorage, { deviceId: syncIdentity.deviceId });
      setStore(s);
      setStatus("unlocked");
      return s;
    },
    [syncIdentity.deviceId],
  );

  const unlockWithPassword = useCallback(
    async (password: string) => {
      const s = await VaultStore.open(readVault(), { password }, fileStorage, {
        deviceId: syncIdentity.deviceId,
      });
      // Derive the sync auth token here — the one moment the master password is legitimately
      // in hand. Held in memory only (this context's state); never persisted. See
      // packages/sync/src/auth.ts and SYNC-DESIGN.md §4.
      setAuthTokenB64(
        syncIdentity.sync.enabled && syncIdentity.sync.accountId
          ? deriveAuthToken(password, s.getHeader().kdf)
          : null,
      );
      setStore(s);
      setStatus("unlocked");
    },
    [syncIdentity.deviceId, syncIdentity.sync.enabled, syncIdentity.sync.accountId],
  );

  const unlockWithRecoveryKey = useCallback(
    async (recoveryKey: string) => {
      // Recovery-key unlock does not yield a KEK, so it cannot produce an auth token
      // (SYNC-DESIGN.md §4). Setting a new master password afterwards does NOT restore sync
      // either: pushing the rotated header requires authenticating with the OLD token, which
      // this device never had. The account has to be reset on the server. The post-recovery
      // flow warns about this — see NOTES/post-recovery-sync-gap.md.
      const s = await VaultStore.open(readVault(), { recoveryKey }, fileStorage, {
        deviceId: syncIdentity.deviceId,
      });
      setStore(s);
      setStatus("unlocked");
      return s;
    },
    [syncIdentity.deviceId],
  );

  const unlockWithBiometrics = useCallback(async (): Promise<boolean> => {
    // The SecureStore read triggers the OS biometric prompt itself.
    const pw = await readMasterPassword();
    if (pw == null) return false;
    try {
      await unlockWithPassword(pw);
      return true;
    } catch (e) {
      if (e instanceof WrongCredentialError) {
        // Master password changed elsewhere — stored credential is stale. Remove it, and also
        // revoke the shared Keychain Vault Key so AutoFill access is revoked too, not just the
        // main app's biometric unlock (a stale-credential situation is a revocation situation).
        await clearStoredMasterPassword();
        await deleteSharedVaultKey();
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
      // iOS only: also mirror the already-derived Vault Key into the shared, Face ID/passcode-
      // gated Keychain item so the AutoFill credentials-provider extension can decrypt items
      // without needing the master password. `store` is guaranteed non-null at every call site
      // (right after an unlock, or from a screen that requires an unlocked vault).
      if (store) await storeSharedVaultKey(store.getVaultKey());
      setPrefs({ biometricEnabled: true });
    },
    [setPrefs, store],
  );

  const disableBiometrics = useCallback(async () => {
    // Order matters: only record biometricEnabled: false once the shared Keychain Vault Key
    // (AutoFill's access) and the local master-password credential are actually gone. If
    // deleteSharedVaultKey throws (a real Keychain failure, not swallowed anymore — see
    // biometric.ts), let it propagate rather than silently marking biometrics disabled while
    // AutoFill can still decrypt the vault.
    await deleteSharedVaultKey();
    await clearStoredMasterPassword();
    await clearCredentialIdentities();
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

  const { status: syncStatus, syncNow, pushHeaderNow, pushRecoveryVerifier } = useSync(
    store,
    syncIdentity,
    updateSyncConfig,
    authTokenB64,
    setAuthTokenB64,
  );

  // Trigger a sync on unlock (once authTokenB64 is available), silently — failures surface
  // via syncStatus.lastError in the Sync settings screen, not a popup on every launch.
  useEffect(() => {
    if (status === "unlocked" && syncIdentity.sync.enabled && authTokenB64) {
      void syncNow({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, authTokenB64, syncIdentity.sync.enabled]);

  // Slow background timer while unlocked (SYNC-DESIGN.md is offline-first; this just keeps
  // devices from drifting too far apart between explicit "Sync now" taps).
  useEffect(() => {
    if (status !== "unlocked" || !syncIdentity.sync.enabled) return;
    const SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const timer = setInterval(() => void syncNow({ silent: true }), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, syncIdentity.sync.enabled, syncNow]);

  // Sync on app foreground (in addition to the existing lock-on-background listener above).
  useEffect(() => {
    if (status !== "unlocked" || !syncIdentity.sync.enabled) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void syncNow({ silent: true });
    });
    return () => sub.remove();
  }, [status, syncIdentity.sync.enabled, syncNow]);

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      errorMessage,
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
      syncIdentity,
      updateSyncConfig,
      authTokenB64,
      syncStatus,
      syncNow,
      pushSyncHeader: pushHeaderNow,
      pushSyncRecoveryVerifier: pushRecoveryVerifier,
    }),
    [status, errorMessage, store, tick, refresh, prefs, setPrefs, createVault, unlockWithPassword,
     unlockWithRecoveryKey, unlockWithBiometrics, lock, adoptStore, enableBiometrics,
     disableBiometrics, reauth, reauthPassword, syncIdentity, updateSyncConfig, authTokenB64,
     syncStatus, syncNow, pushHeaderNow, pushRecoveryVerifier],
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

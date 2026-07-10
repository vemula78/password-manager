// Unlock screen: master-password unlock with client-side rate limiting, recovery-key
// unlock (forces a new master password + offers key rotation), and restore-from-backup.
import {
  hasRecovery,
  parseVaultFile,
  VaultStore,
  WrongCredentialError,
} from "@pw/core";
import { useEffect, useMemo, useState } from "react";
import { KitOverlay, kitFromStore } from "../components/Kit";
import { RestorePanel } from "../components/Restore";
import { StrengthMeter, Warning } from "../components/ui";
import {
  loadConfig,
  recordFailedUnlock,
  resetUnlockFails,
} from "../lib/config";
import { idbAdapter } from "../lib/storage";

type Mode = "password" | "recovery" | "restore";
type RecoveryStage = "key" | "newpass" | "rotate";

export function Unlock(props: { blob: string; onUnlocked: (s: VaultStore) => void }) {
  const [mode, setMode] = useState<Mode>("password");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(() => loadConfig());
  const [nowTick, setNowTick] = useState(Date.now());

  // Recovery flow state
  const [recKey, setRecKey] = useState("");
  const [recStage, setRecStage] = useState<RecoveryStage>("key");
  const [recStore, setRecStore] = useState<VaultStore | null>(null);
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [kit, setKit] = useState<ReturnType<typeof kitFromStore> | null>(null);

  const recoveryAvailable = useMemo(() => {
    try {
      return hasRecovery(parseVaultFile(props.blob).header);
    } catch {
      return false;
    }
  }, [props.blob]);

  const blockedForMs = Math.max(0, config.unlock.until - nowTick);
  useEffect(() => {
    if (blockedForMs <= 0) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [blockedForMs > 0]);

  const finishUnlock = async (store: VaultStore) => {
    // Flush queued failed-unlock attempts into the encrypted audit log, then reset backoff.
    const pending = config.unlock.pendingAuditCount;
    if (pending > 0) {
      await store.logAndPersist(
        "failed_unlock",
        `${pending} failed unlock attempt${pending > 1 ? "s" : ""} before this unlock`,
      );
    }
    setConfig(resetUnlockFails(config));
    props.onUnlocked(store);
  };

  const unlockWithPwd = async () => {
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const store = await VaultStore.open(props.blob, { password: pwd }, idbAdapter);
      await finishUnlock(store);
    } catch (e) {
      if (e instanceof WrongCredentialError) {
        const next = recordFailedUnlock(config);
        setConfig(next);
        setNowTick(Date.now());
        setErr(e.message);
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
      setPwd("");
      setBusy(false);
    }
  };

  const unlockWithRecovery = async () => {
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const store = await VaultStore.open(props.blob, { recoveryKey: recKey }, idbAdapter);
      setRecStore(store);
      setRecStage("newpass");
      setBusy(false);
    } catch (e) {
      if (e instanceof WrongCredentialError) {
        const next = recordFailedUnlock(config);
        setConfig(next);
        setNowTick(Date.now());
      }
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const setNewMasterPassword = async () => {
    if (!recStore) return;
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      await recStore.changeMasterPassword(newPwd);
      setRecStage("rotate");
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const rotateKey = async () => {
    if (!recStore) return;
    setBusy(true);
    try {
      const key = await recStore.createRecoveryKey();
      setKit(kitFromStore(recStore, key));
    } finally {
      setBusy(false);
    }
  };

  if (kit && recStore) {
    return (
      <KitOverlay
        kit={kit}
        onClose={() => {
          setKit(null);
          void finishUnlock(recStore);
        }}
        onPrinted={() => void recStore.logAndPersist("emergency_kit_exported")}
      />
    );
  }

  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="brand">
          <span className="brand-icon">🔐</span>
          <h1>Password Vault</h1>
        </div>

        {mode === "password" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pwd && !busy && blockedForMs <= 0) void unlockWithPwd();
            }}
          >
            <label className="field">
              <span>Master password</span>
              <input
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                autoFocus
                autoComplete="current-password"
              />
            </label>
            {err && <p className="error">{err}</p>}
            {blockedForMs > 0 && (
              <p className="error">
                Too many failed attempts. Try again in {Math.ceil(blockedForMs / 1000)}s.
              </p>
            )}
            <button
              type="submit"
              className="btn primary full"
              disabled={!pwd || busy || blockedForMs > 0}
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
            <div className="auth-links">
              {recoveryAvailable && (
                <button type="button" className="link-btn" onClick={() => { setMode("recovery"); setErr(""); }}>
                  Recover with recovery key
                </button>
              )}
              <button type="button" className="link-btn" onClick={() => { setMode("restore"); setErr(""); }}>
                Restore from backup
              </button>
            </div>
          </form>
        )}

        {mode === "recovery" && recStage === "key" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (recKey && !busy && blockedForMs <= 0) void unlockWithRecovery();
            }}
          >
            <h2>Recover with recovery key</h2>
            <p className="muted">
              Enter the recovery key from your printed emergency kit (dashes optional).
            </p>
            <label className="field">
              <span>Recovery key</span>
              <input
                type="text"
                value={recKey}
                onChange={(e) => setRecKey(e.target.value)}
                placeholder="ABCDE-FGHJK-MNPQR-STVWX-YZ012-3"
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {err && <p className="error">{err}</p>}
            {blockedForMs > 0 && (
              <p className="error">
                Too many failed attempts. Try again in {Math.ceil(blockedForMs / 1000)}s.
              </p>
            )}
            <button type="submit" className="btn primary full" disabled={!recKey || busy || blockedForMs > 0}>
              {busy ? "Checking…" : "Recover vault"}
            </button>
            <div className="auth-links">
              <button type="button" className="link-btn" onClick={() => { setMode("password"); setErr(""); }}>
                Back to unlock
              </button>
            </div>
          </form>
        )}

        {mode === "recovery" && recStage === "newpass" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newPwd && newPwd === newPwd2 && !busy) void setNewMasterPassword();
            }}
          >
            <h2>Set a new master password</h2>
            <p className="muted">
              Recovery unlocked your vault. Choose a new master password now — the old one no
              longer matters. A long passphrase of 4–5 random words is easiest to remember.
            </p>
            <label className="field">
              <span>New master password</span>
              <input
                type="password"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                autoFocus
                autoComplete="new-password"
              />
            </label>
            <StrengthMeter password={newPwd} />
            <label className="field">
              <span>Confirm new master password</span>
              <input
                type="password"
                value={newPwd2}
                onChange={(e) => setNewPwd2(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {newPwd2 && newPwd !== newPwd2 && <p className="error">Passwords do not match.</p>}
            {err && <p className="error">{err}</p>}
            <button
              type="submit"
              className="btn primary full"
              disabled={!newPwd || newPwd !== newPwd2 || busy}
            >
              {busy ? "Saving…" : "Set new master password"}
            </button>
          </form>
        )}

        {mode === "recovery" && recStage === "rotate" && recStore && (
          <div>
            <h2>Rotate your recovery key?</h2>
            <Warning>
              The recovery key you just used still works. If it may have been seen by anyone
              else, rotate it now and print a fresh emergency kit.
            </Warning>
            <div className="btn-row">
              <button className="btn" onClick={() => void finishUnlock(recStore)} disabled={busy}>
                Keep existing key
              </button>
              <button className="btn primary" onClick={() => void rotateKey()} disabled={busy}>
                {busy ? "Rotating…" : "Rotate key & show new kit"}
              </button>
            </div>
          </div>
        )}

        {mode === "restore" && (
          <div>
            <h2>Restore from backup</h2>
            <RestorePanel
              hasLocalVault={true}
              driveClientId={config.driveClientId}
              onRestored={(s) => void finishUnlock(s)}
              onCancel={() => { setMode("password"); setErr(""); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

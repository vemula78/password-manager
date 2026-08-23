// Shared "just unlocked via recovery key" flow: force a new master password (core allows
// changeMasterPassword without reauth once unlocked via recovery), then offer rotating the
// recovery key. Used by both Unlock.tsx (recover-and-unlock) and Restore.tsx (restore a
// backup using its recovery key) so the two paths behave identically.
import { type VaultStore } from "@pw/core";
import { useState } from "react";
import { SyncClient, deriveAuthToken, deriveRecoveryAuthToken } from "@pw/sync";
import { loadConfig, saveConfig } from "../lib/config";
import { KitOverlay, kitFromStore } from "./Kit";
import { StrengthMeter, Warning } from "./ui";

type Stage = "newpass" | "rotate";

/**
 * Bring the sync server along after a recovery-key unlock.
 *
 * A recovering device has no KEK and therefore no password credential, so it signs in with
 * the recovery-derived verifier instead (SYNC-DESIGN.md §4) and pushes the rewrapped header
 * together with the new password verifier, atomically. Without this the server keeps the OLD
 * header, the OLD master password goes on working against it, and every other device stays
 * stranded — see NOTES/post-recovery-sync-gap.md.
 *
 * Returns a message to show the user when it could not be done, or null on success (or when
 * there is nothing to do). Never throws: the local password change has already happened and
 * must not be reported as failed.
 */
async function pushRecoveredHeader(
  store: VaultStore,
  recoveryKey: string | undefined,
  newPassword: string,
  newRecoveryKey?: string,
): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg.sync.enabled || !cfg.sync.serverUrl || !cfg.sync.accountId) return null;
  if (!recoveryKey) {
    return (
      "Sync was not updated: this vault was opened without a recovery key, so there is no " +
      "credential this device can use to prove itself to the sync server."
    );
  }

  const fail = (msg: string): string => {
    saveConfig({ ...loadConfig(), sync: { ...loadConfig().sync, lastError: msg } });
    return msg;
  };

  try {
    const client = new SyncClient({
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      serverUrl: cfg.sync.serverUrl,
      deviceId: cfg.deviceId,
      deviceLabel: cfg.deviceLabel,
    });
    await client.loginWithRecovery(cfg.sync.accountId, deriveRecoveryAuthToken(recoveryKey));
    const res = await client.pushHeader(
      store,
      {
        lastSyncRev: cfg.sync.lastSyncRev,
        highestSeenRev: cfg.sync.highestSeenRev,
        lastHeaderRev: cfg.sync.lastHeaderRev,
      },
      {
        newAuthTokenB64: deriveAuthToken(newPassword, store.getHeader().kdf),
        ...(newRecoveryKey !== undefined
          ? { newRecoveryAuthTokenB64: deriveRecoveryAuthToken(newRecoveryKey) }
          : {}),
      },
    );
    const fresh = loadConfig();
    saveConfig({
      ...fresh,
      sync: { ...fresh.sync, lastHeaderRev: res.state.lastHeaderRev ?? 0, lastError: null },
    });
    return null;
  } catch (e) {
    return fail(
      "Your master password was changed on this device, but the sync server could not be " +
        "updated: " +
        (e instanceof Error ? e.message : String(e)) +
        " Your old password still works for sync until this succeeds. If this account has no " +
        "recovery credential registered, reset it on the sync server and connect again.",
    );
  }
}

export function PostRecoveryFlow(props: {
  store: VaultStore;
  /**
   * The recovery key just used to unlock, when there was one. It is the only credential a
   * recovering device can present to the sync server, and it exists only here — so it is
   * passed in rather than re-prompted for.
   */
  recoveryKey?: string;
  /** Called once the user is done (kept existing key, or closed the new kit overlay). */
  onDone: (store: VaultStore) => void;
}) {
  const { store } = props;
  const [stage, setStage] = useState<Stage>("newpass");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [kit, setKit] = useState<ReturnType<typeof kitFromStore> | null>(null);
  const [syncProblem, setSyncProblem] = useState<string | null>(null);

  const setNewMasterPassword = async () => {
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      await store.changeMasterPassword(newPwd);
      setSyncProblem(await pushRecoveredHeader(store, props.recoveryKey, newPwd));
      setStage("rotate");
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const rotateKey = async () => {
    setBusy(true);
    try {
      const key = await store.createRecoveryKey();
      // The rotation replaced the recovery envelopes in the header, so the server needs both
      // the new header and the new recovery verifier — otherwise the printed kit the user is
      // about to keep would not work for recovery sign-in.
      setSyncProblem(await pushRecoveredHeader(store, props.recoveryKey, newPwd, key));
      setKit(kitFromStore(store, key));
    } finally {
      setBusy(false);
    }
  };

  if (kit) {
    return (
      <KitOverlay
        kit={kit}
        onClose={() => {
          setKit(null);
          props.onDone(store);
        }}
        onPrinted={() => void store.logAndPersist("emergency_kit_exported")}
      />
    );
  }

  if (stage === "newpass") {
    return (
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
    );
  }

  return (
    <div>
      <h2>Rotate your recovery key?</h2>
      {syncProblem && <Warning>{syncProblem}</Warning>}
      <Warning>
        The recovery key you just used still works. If it may have been seen by anyone
        else, rotate it now and print a fresh emergency kit.
      </Warning>
      <div className="btn-row">
        <button className="btn" onClick={() => props.onDone(store)} disabled={busy}>
          Keep existing key
        </button>
        <button className="btn primary" onClick={() => void rotateKey()} disabled={busy}>
          {busy ? "Rotating…" : "Rotate key & show new kit"}
        </button>
      </div>
    </div>
  );
}

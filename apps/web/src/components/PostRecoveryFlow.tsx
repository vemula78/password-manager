// Shared "just unlocked via recovery key" flow: force a new master password (core allows
// changeMasterPassword without reauth once unlocked via recovery), then offer rotating the
// recovery key. Used by both Unlock.tsx (recover-and-unlock) and Restore.tsx (restore a
// backup using its recovery key) so the two paths behave identically.
import { type VaultStore } from "@pw/core";
import { useState } from "react";
import { KitOverlay, kitFromStore } from "./Kit";
import { StrengthMeter, Warning } from "./ui";

type Stage = "newpass" | "rotate";

export function PostRecoveryFlow(props: {
  store: VaultStore;
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

  const setNewMasterPassword = async () => {
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      await store.changeMasterPassword(newPwd);
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

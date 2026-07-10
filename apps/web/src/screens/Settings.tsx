// Settings: change master password, rotate recovery key / reprint emergency kit,
// clipboard & auto-lock timers, kit contact details, activity history, lock now.
import { verifyMasterPassword, type EmergencyKit } from "@pw/core";
import { useMemo, useState } from "react";
import { KitOverlay, kitFromStore } from "../components/Kit";
import { formatDateTime, Modal, StrengthMeter, Warning } from "../components/ui";
import { useApp } from "../ctx";

export function Settings() {
  const app = useApp();
  const { store, rev } = app;
  const s = store.settings;

  const [showChangePwd, setShowChangePwd] = useState(false);
  const [kit, setKit] = useState<EmergencyKit | null>(null);
  const [busyRotate, setBusyRotate] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [ownerName, setOwnerName] = useState(s.ownerName);
  const [contact, setContact] = useState(s.emergencyContact);

  const audit = useMemo(() => store.getAudit(), [store, rev, showAudit]);

  const rotateKey = async () => {
    const reauth = await app.requestReauth("Rotating the recovery key invalidates the old one.");
    if (!reauth) return;
    setBusyRotate(true);
    try {
      const key = await store.createRecoveryKey(reauth);
      store.log("recovery_key_viewed");
      await store.persist();
      setKit(kitFromStore(store, key));
      app.refresh();
    } finally {
      setBusyRotate(false);
    }
  };

  const saveKitDetails = async () => {
    await store.updateSettings({ ownerName: ownerName.trim(), emergencyContact: contact.trim() });
    app.refresh();
    app.toast("Saved", "success");
  };

  return (
    <div className="screen narrow">
      <h2>Settings</h2>

      <div className="card">
        <h3>Security</h3>
        <div className="btn-row">
          <button className="btn" onClick={() => setShowChangePwd(true)}>
            Change master password
          </button>
          <button className="btn" onClick={() => void rotateKey()} disabled={busyRotate}>
            {busyRotate ? "Rotating…" : "Rotate recovery key & print new kit"}
          </button>
          <button className="btn" onClick={app.lockNow}>
            🔒 Lock now
          </button>
        </div>
        <p className="muted small">
          The recovery key can't be shown again — rotating generates a new key and a fresh
          printable emergency kit, and the old key stops working.
        </p>
        <div className="form-grid">
          <label className="field">
            <span>Clear clipboard after (seconds)</span>
            <input
              type="number"
              min={5}
              max={300}
              value={s.clipboardClearSeconds}
              onChange={(e) => {
                const v = Math.max(5, Math.min(300, Number(e.target.value) || 30));
                void store.updateSettings({ clipboardClearSeconds: v }).then(app.refresh);
              }}
            />
          </label>
          <label className="field">
            <span>Auto-lock after inactivity (minutes)</span>
            <input
              type="number"
              min={1}
              max={120}
              value={s.autoLockMinutes}
              onChange={(e) => {
                const v = Math.max(1, Math.min(120, Number(e.target.value) || 5));
                void store.updateSettings({ autoLockMinutes: v }).then(app.refresh);
              }}
            />
          </label>
        </div>
        <p className="muted small">The vault also locks when this tab stays hidden for over a minute.</p>
      </div>

      <div className="card">
        <h3>Emergency kit details</h3>
        <p className="muted">Printed on the emergency kit so a trusted person knows whose vault it is.</p>
        <div className="form-grid">
          <label className="field">
            <span>Owner name</span>
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label className="field">
            <span>Emergency contact</span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Name + phone of a trusted person"
            />
          </label>
        </div>
        <button className="btn" onClick={() => void saveKitDetails()}>
          Save details
        </button>
      </div>

      <div className="card">
        <h3>Activity history</h3>
        <p className="muted">
          A local, encrypted log of security-relevant events. It never leaves this device.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => setShowAudit((v) => !v)}>
            {showAudit ? "Hide history" : `View history (${audit.length})`}
          </button>
          {confirmClear ? (
            <button
              className="btn danger"
              onClick={() =>
                void store.clearAudit().then(() => {
                  setConfirmClear(false);
                  app.refresh();
                })
              }
            >
              Really clear all history?
            </button>
          ) : (
            <button className="btn" onClick={() => setConfirmClear(true)}>
              Clear history
            </button>
          )}
        </div>
        {showAudit && (
          <div className="audit-list">
            {audit.length === 0 && <p className="muted">No events.</p>}
            {audit.map((e, i) => (
              <div className="list-row static" key={i}>
                <span>
                  <code className="audit-type">{e.type}</code>
                  {e.detail && <span className="muted"> — {e.detail}</span>}
                </span>
                <span className="muted">{formatDateTime(e.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}

      {kit && (
        <KitOverlay
          kit={kit}
          onClose={() => setKit(null)}
          onPrinted={() => void store.logAndPersist("emergency_kit_exported")}
        />
      )}
    </div>
  );
}

function ChangePasswordModal(props: { onClose: () => void }) {
  const app = useApp();
  const { store } = app;
  const [current, setCurrent] = useState("");
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (!verifyMasterPassword(store.getHeader(), current)) {
        setErr("Current master password is incorrect.");
        setCurrent("");
        setBusy(false);
        return;
      }
      await store.changeMasterPassword(pwd, { masterPassword: current });
      app.refresh();
      app.toast("Master password changed", "success");
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Change master password" onClose={props.onClose}>
      <Warning>
        Your recovery key keeps working after this change. If you suspect it was exposed,
        rotate it too.
      </Warning>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (current && pwd && pwd === pwd2 && !busy) void submit();
        }}
      >
        <label className="field">
          <span>Current master password</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />
        </label>
        <label className="field">
          <span>New master password</span>
          <input
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <StrengthMeter password={pwd} />
        <label className="field">
          <span>Confirm new master password</span>
          <input
            type="password"
            value={pwd2}
            onChange={(e) => setPwd2(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {pwd2 && pwd !== pwd2 && <p className="error">Passwords do not match.</p>}
        {err && <p className="error">{err}</p>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={!current || !pwd || pwd !== pwd2 || busy}
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

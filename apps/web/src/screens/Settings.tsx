// Settings: change master password, rotate recovery key / reprint emergency kit,
// clipboard & auto-lock timers, kit contact details, activity history, lock now,
// import logins from a CSV export (Apple Passwords, Chrome, generic).
import { parseCsvToLoginItems, verifyMasterPassword, type EmergencyKit, type ImportedLoginRow } from "@pw/core";
import { useMemo, useRef, useState } from "react";
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

      <div className="card">
        <h3>Import logins</h3>
        <p className="muted">
          Import a CSV export from Apple Passwords, Chrome, or another password manager.
          Each row becomes a Login item — nothing is uploaded anywhere, the file is read
          only in this browser tab.
        </p>
        <Warning>
          The export file itself is <strong>plain, unencrypted text</strong> containing your
          real passwords. Delete it from your device (and Downloads folder) once the import
          below is done.
        </Warning>
        <ImportCsv />
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

function ImportCsv() {
  const app = useApp();
  const { store } = app;
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ fileName: string; rows: ImportedLoginRow[]; skipped: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onFile = async (file: File) => {
    setErr("");
    setPending(null);
    try {
      const text = await file.text();
      const { items, skipped, truncated } = parseCsvToLoginItems(text);
      if (items.length === 0) {
        setErr("No importable rows found. Expected columns like Title/URL/Username/Password.");
        return;
      }
      setPending({ fileName: file.name, rows: items, skipped, truncated });
    } catch {
      setErr("Could not read that file as CSV.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      for (const row of pending.rows) {
        await store.addItem({
          type: "login",
          title: row.title,
          fields: row.fields,
          notes: row.notes,
          customFields: row.otpauth
            ? [{ label: "TOTP secret (otpauth URI)", value: row.otpauth, sensitive: true }]
            : [],
        });
      }
      await store.logAndPersist("items_imported", `${pending.rows.length} items from CSV`);
      app.refresh();
      app.toast(`Imported ${pending.rows.length} item${pending.rows.length === 1 ? "" : "s"}`, "success");
      setPending(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="btn-row">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Choose CSV file…
        </button>
      </div>
      {err && <p className="error">{err}</p>}

      {pending && (
        <Modal title={`Import from ${pending.fileName}`} onClose={() => setPending(null)}>
          <p>
            Found <strong>{pending.rows.length}</strong> login
            {pending.rows.length === 1 ? "" : "s"} to import
            {pending.skipped > 0 ? ` (${pending.skipped} blank/empty row${pending.skipped === 1 ? "" : "s"} skipped)` : ""}.
          </p>
          {pending.truncated && (
            <Warning>This file has more rows than fit in one import; only the first rows shown were included.</Warning>
          )}
          <div className="audit-list">
            {pending.rows.slice(0, 20).map((r, i) => (
              <div className="list-row static" key={i}>
                <span>{r.title}</span>
                <span className="muted">{r.fields.username ?? ""}</span>
              </div>
            ))}
            {pending.rows.length > 20 && (
              <p className="muted small">…and {pending.rows.length - 20} more.</p>
            )}
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void confirmImport()} disabled={busy}>
              {busy ? "Importing…" : `Import ${pending.rows.length} item${pending.rows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Modal>
      )}
    </>
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

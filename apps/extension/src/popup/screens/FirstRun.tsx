// First-run screen: the extension holds its OWN encrypted vault copy, imported from a
// .pwmbackup file exported by the web/mobile app. There is no live sync (V2). Re-importing
// later replaces this copy — same flow, reachable again from the Locked screen.
import { useRef, useState } from "react";
import { call } from "../api";

export function FirstRun(props: { onImported: () => void }) {
  const [backupText, setBackupText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [credKind, setCredKind] = useState<"password" | "recoveryKey">("password");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (f: File) => {
    setErr("");
    setBackupText(await f.text());
    setFileName(f.name);
  };

  const doImport = async () => {
    if (!backupText || !secret) return;
    setBusy(true);
    setErr("");
    const credential = credKind === "password" ? { password: secret } : { recoveryKey: secret };
    const res = await call<{ ok: true } | { ok: false; error: string }>({
      kind: "IMPORT_BACKUP",
      backupText,
      credential,
    });
    setBusy(false);
    if (res.ok) {
      props.onImported();
    } else {
      setErr(res.error);
      setSecret("");
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="domain">Password Vault — Extension</span>
      </div>
      <div className="content">
        <div className="card">
          <p>
            This extension keeps its <strong>own encrypted copy</strong> of your vault, imported
            from a <code>.pwmbackup</code> file exported by the web or mobile app. It does not
            sync live with your other devices (planned for a future version) — re-import a fresh
            backup any time to bring the copy up to date.
          </p>
          <p className="muted">
            The imported copy is stored on this device as ciphertext only; it can only be
            decrypted with your master password or recovery key.
          </p>
        </div>

        <div className="card">
          {!backupText ? (
            <>
              <p className="muted">Choose a .pwmbackup file exported from Backup &amp; Restore.</p>
              <button className="btn full" onClick={() => fileRef.current?.click()}>
                Choose .pwmbackup file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".pwmbackup,application/octet-stream,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = "";
                }}
              />
            </>
          ) : (
            <>
              <p>
                <strong>File:</strong> {fileName}{" "}
                <button className="link-btn" onClick={() => { setBackupText(null); setSecret(""); }}>
                  change
                </button>
              </p>
              <div className="checkline">
                <label>
                  <input
                    type="radio"
                    checked={credKind === "password"}
                    onChange={() => setCredKind("password")}
                  />{" "}
                  Master password
                </label>
              </div>
              <div className="checkline">
                <label>
                  <input
                    type="radio"
                    checked={credKind === "recoveryKey"}
                    onChange={() => setCredKind("recoveryKey")}
                  />{" "}
                  Recovery key
                </label>
              </div>
              <label className="field">
                <span>{credKind === "password" ? "Master password" : "Recovery key"}</span>
                <input
                  type={credKind === "password" ? "password" : "text"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoFocus
                  autoComplete="off"
                />
              </label>
              {err && <p className="error">{err}</p>}
              <button className="btn primary full" disabled={!secret || busy} onClick={() => void doImport()}>
                {busy ? "Importing…" : "Import backup"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared restore flow: pick a backup (.pwmbackup file or Google Drive), provide the
// backup's master password OR recovery key, and — if a local vault already exists —
// type RESTORE to confirm replacing it. Works from the unlock screen and Backup screen.
import {
  type DriveFile,
  parseBackup,
  restoreBackup,
  VaultStore,
} from "@pw/core";
import { useRef, useState } from "react";
import { connectDrive, driveConnected, getDriveClient } from "../lib/gdrive";
import { idbAdapter, saveVaultBlob } from "../lib/storage";
import { formatDateTime, Warning } from "./ui";

export function RestorePanel(props: {
  hasLocalVault: boolean;
  driveClientId: string;
  onRestored: (store: VaultStore) => void;
  onCancel: () => void;
  /** Skip source selection — restore this already-downloaded backup. */
  preloaded?: { text: string; label: string };
}) {
  const [backupText, setBackupText] = useState<string | null>(props.preloaded?.text ?? null);
  const [backupInfo, setBackupInfo] = useState(props.preloaded?.label ?? "");
  const [credKind, setCredKind] = useState<"password" | "recoveryKey">("password");
  const [secret, setSecret] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [driveFiles, setDriveFiles] = useState<DriveFile[] | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadText = (text: string, sourceLabel: string) => {
    setErr("");
    try {
      const pkg = parseBackup(text);
      setBackupText(text);
      setBackupInfo(`${sourceLabel} — created ${formatDateTime(pkg.createdAt)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onFile = async (f: File) => {
    loadText(await f.text(), f.name);
  };

  const listDrive = async () => {
    setDriveBusy(true);
    setErr("");
    try {
      if (!navigator.onLine) throw new Error("You are offline — Google Drive is unavailable.");
      if (!driveConnected()) await connectDrive(props.driveClientId);
      const client = getDriveClient();
      const folderId = await client.ensureFolder();
      setDriveFiles(await client.listBackups(folderId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDriveBusy(false);
    }
  };

  const pickDriveFile = async (f: DriveFile) => {
    setDriveBusy(true);
    setErr("");
    try {
      loadText(await getDriveClient().downloadBackup(f.id), f.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDriveBusy(false);
    }
  };

  const doRestore = async () => {
    if (!backupText) return;
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30)); // let the busy state paint before Argon2id
    try {
      const credential =
        credKind === "password" ? { password: secret } : { recoveryKey: secret };
      const { vaultSerialized } = restoreBackup(backupText, credential);
      await saveVaultBlob(vaultSerialized);
      const store = await VaultStore.open(vaultSerialized, credential, idbAdapter);
      await store.logAndPersist("restore_completed");
      props.onRestored(store);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const needsConfirm = props.hasLocalVault;
  const canRestore =
    !!backupText && !!secret && (!needsConfirm || confirmText === "RESTORE") && !busy;

  return (
    <div className="restore-panel">
      {!backupText && (
        <>
          <p className="muted">Choose the encrypted backup to restore from.</p>
          <div className="btn-row">
            <button className="btn" onClick={() => fileRef.current?.click()}>
              Upload .pwmbackup file
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
            {props.driveClientId ? (
              <button className="btn" onClick={() => void listDrive()} disabled={driveBusy}>
                {driveBusy ? "Contacting Google Drive…" : "From Google Drive"}
              </button>
            ) : (
              <span className="muted">
                (Google Drive restore needs an OAuth Client ID configured in Backup settings.)
              </span>
            )}
          </div>
          {driveFiles && (
            <div className="drive-list">
              {driveFiles.length === 0 && <p className="muted">No backups found in Drive.</p>}
              {driveFiles.map((f) => (
                <button key={f.id} className="list-row" onClick={() => void pickDriveFile(f)}>
                  <span>{f.name}</span>
                  <span className="muted">{formatDateTime(f.createdTime)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {backupText && (
        <>
          <p>
            <strong>Backup:</strong> {backupInfo}{" "}
            <button
              className="link-btn"
              onClick={() => {
                setBackupText(null);
                setSecret("");
                setConfirmText("");
              }}
            >
              change
            </button>
          </p>
          <div className="seg-row" role="radiogroup" aria-label="Unlock backup with">
            <label>
              <input
                type="radio"
                checked={credKind === "password"}
                onChange={() => setCredKind("password")}
              />{" "}
              Master password of the backup
            </label>
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
            <span>{credKind === "password" ? "Master password" : "Recovery key (e.g. ABCDE-FGHJK-…)"}</span>
            <input
              type={credKind === "password" ? "password" : "text"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
            />
          </label>
          {needsConfirm && (
            <>
              <Warning>
                Restoring will REPLACE the vault currently on this device with the backup's
                contents. This cannot be undone.
              </Warning>
              <label className="field">
                <span>Type RESTORE to confirm</span>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </>
      )}

      {err && <p className="error">{err}</p>}
      <div className="btn-row">
        <button className="btn" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void doRestore()} disabled={!canRestore}>
          {busy ? "Restoring…" : "Restore vault"}
        </button>
      </div>
    </div>
  );
}

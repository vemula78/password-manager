// Backup & restore: local encrypted export/import, Google Drive encrypted backups
// (connect, backup now, list, restore, retention/frequency), status + audit logging.
import {
  backupFileName,
  createBackup,
  type DriveFile,
  type VaultStore,
} from "@pw/core";
import { useEffect, useState } from "react";
import { RestorePanel } from "../components/Restore";
import { formatDateTime, Modal, Warning } from "../components/ui";
import { useApp } from "../ctx";
import {
  connectDrive,
  disconnectDrive,
  driveConnected,
  getDriveClient,
} from "../lib/gdrive";

export function Backup() {
  const app = useApp();
  const { store, rev, config } = app;
  const b = store.settings.backup;
  const online = navigator.onLine;

  const [clientIdInput, setClientIdInput] = useState(config.driveClientId);
  const [connected, setConnected] = useState(driveConnected());
  const [driveFiles, setDriveFiles] = useState<DriveFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreMode, setRestoreMode] = useState<null | { preloaded?: { text: string; label: string } }>(null);

  useEffect(() => setClientIdInput(config.driveClientId), [config.driveClientId]);

  const setBackupSettings = async (patch: Partial<typeof b>) => {
    await store.updateSettings({ backup: { ...store.settings.backup, ...patch } });
    app.refresh();
  };

  /* ---- local export ---- */
  const exportLocal = async () => {
    setBusy("export");
    try {
      const now = new Date();
      const content = createBackup(store, now.toISOString());
      const blob = new Blob([content], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFileName(now);
      a.click();
      URL.revokeObjectURL(url);
      await setBackupSettings({ lastSuccessAt: now.toISOString(), lastError: null });
      await store.logAndPersist("backup_completed", "local export");
      app.toast("Encrypted backup downloaded", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await setBackupSettings({ lastError: msg });
      await store.logAndPersist("backup_failed", `local export: ${msg}`);
      app.toast(msg, "error");
    } finally {
      setBusy(null);
      app.refresh();
    }
  };

  /* ---- Drive ---- */
  const connect = async () => {
    setBusy("connect");
    try {
      app.updateConfig({ driveClientId: clientIdInput.trim() });
      await connectDrive(clientIdInput.trim());
      setConnected(true);
      app.toast("Google Drive connected", "success");
      await refreshList();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const refreshList = async () => {
    try {
      const client = getDriveClient();
      const folderId = await client.ensureFolder();
      if (folderId !== store.settings.backup.driveFolderId) {
        await setBackupSettings({ driveFolderId: folderId });
      }
      setDriveFiles(await client.listBackups(folderId));
    } catch (e) {
      app.toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const backupNow = async () => {
    setBusy("backup");
    try {
      const now = new Date();
      const client = getDriveClient();
      const folderId = await client.ensureFolder();
      const content = createBackup(store, now.toISOString());
      await client.uploadBackup(folderId, backupFileName(now), content);
      await client.prune(folderId, store.settings.backup.retention);
      await setBackupSettings({
        lastSuccessAt: now.toISOString(),
        lastError: null,
        driveFolderId: folderId,
      });
      await store.logAndPersist("backup_completed", "Google Drive");
      app.toast("Encrypted backup uploaded to Google Drive", "success");
      setDriveFiles(await client.listBackups(folderId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await setBackupSettings({ lastError: msg });
      await store.logAndPersist("backup_failed", `Google Drive: ${msg}`);
      app.toast(msg, "error");
    } finally {
      setBusy(null);
      app.refresh();
    }
  };

  const restoreFromDrive = async (f: DriveFile) => {
    setBusy(`dl-${f.id}`);
    try {
      const text = await getDriveClient().downloadBackup(f.id);
      setRestoreMode({ preloaded: { text, label: f.name } });
    } catch (e) {
      app.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const onRestored = (s: VaultStore) => {
    setRestoreMode(null);
    app.replaceStore(s);
    app.toast("Vault restored from backup", "success");
    app.navigate({ name: "dashboard" });
  };

  return (
    <div className="screen narrow" key={rev}>
      <h2>Backup &amp; restore</h2>
      <Warning>
        Google Drive backup is encrypted, but losing both your master password and recovery key
        may make recovery impossible. Backups can only be opened with your master password or
        recovery key.
      </Warning>

      <div className="card">
        <h3>Status</h3>
        <p>
          Last successful backup: <strong>{formatDateTime(b.lastSuccessAt)}</strong>
        </p>
        {b.lastError && <p className="error">Last error: {b.lastError}</p>}
        <div className="form-grid">
          <label className="field">
            <span>Automatic backup reminder</span>
            <select
              value={b.frequency}
              onChange={(e) => void setBackupSettings({ frequency: e.target.value as typeof b.frequency })}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly (recommended)</option>
              <option value="monthly">Monthly</option>
              <option value="manual">Manual only</option>
            </select>
          </label>
          <label className="field">
            <span>Keep last N Drive backups</span>
            <select
              value={b.retention}
              onChange={(e) => void setBackupSettings({ retention: Number(e.target.value) })}
            >
              <option value={7}>7</option>
              <option value={14}>14</option>
              <option value={30}>30</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          When a backup is due, you'll get a gentle prompt after unlocking — nothing uploads
          without you pressing “Backup now”.
        </p>
      </div>

      <div className="card">
        <h3>Local encrypted backup</h3>
        <p className="muted">
          Downloads a <code>.pwmbackup</code> file — fully encrypted, safe to keep on a pen
          drive or any storage.
        </p>
        <div className="btn-row">
          <button className="btn primary" onClick={() => void exportLocal()} disabled={busy === "export"}>
            {busy === "export" ? "Exporting…" : "Download encrypted backup"}
          </button>
          <button className="btn" onClick={() => setRestoreMode({})}>
            Restore from backup…
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Google Drive</h3>
        {!online && <p className="error">You are offline — Google Drive is unavailable. Local backup still works.</p>}
        {!config.driveClientId && (
          <div className="explainer">
            <p>
              To use Drive backup you need a (free) Google OAuth Client ID — a one-time,
              5-minute setup:
            </p>
            <ol>
              <li>
                Open{" "}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                  Google Cloud console → APIs &amp; Services → Credentials
                </a>{" "}
                and create an <strong>OAuth client ID</strong> of type <strong>Web application</strong>.
              </li>
              <li>Add this app's origin (<code>{location.origin}</code>) to “Authorised JavaScript origins”.</li>
              <li>Enable the <strong>Google Drive API</strong> for the project, then paste the Client ID below.</li>
            </ol>
            <p className="muted small">
              The Client ID is not a secret; it is stored only in this browser. Backups go to a
              “PasswordManagerBackups” folder in your own Drive and are encrypted before upload.
            </p>
          </div>
        )}
        <label className="field">
          <span>OAuth Client ID</span>
          <input
            type="text"
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            placeholder="1234567890-xxxxxxxx.apps.googleusercontent.com"
            spellCheck={false}
          />
        </label>
        <div className="btn-row">
          {!connected ? (
            <button
              className="btn primary"
              onClick={() => void connect()}
              disabled={!clientIdInput.trim() || !online || busy === "connect"}
            >
              {busy === "connect" ? "Connecting…" : "Connect Google Drive"}
            </button>
          ) : (
            <>
              <button className="btn primary" onClick={() => void backupNow()} disabled={busy === "backup" || !online}>
                {busy === "backup" ? "Backing up…" : "Backup now"}
              </button>
              <button className="btn" onClick={() => void refreshList()} disabled={!online}>
                Refresh list
              </button>
              <button
                className="btn"
                onClick={() => {
                  disconnectDrive();
                  setConnected(false);
                  setDriveFiles(null);
                }}
              >
                Disconnect
              </button>
            </>
          )}
        </div>

        {connected && driveFiles && (
          <div className="drive-list">
            <h4>Backups in Drive ({driveFiles.length})</h4>
            {driveFiles.length === 0 && <p className="muted">No backups yet — run “Backup now”.</p>}
            {driveFiles.map((f) => (
              <div key={f.id} className="list-row static">
                <span>
                  {f.name}
                  <span className="muted"> · {formatDateTime(f.createdTime)}</span>
                </span>
                <button
                  className="btn tiny"
                  disabled={busy === `dl-${f.id}`}
                  onClick={() => void restoreFromDrive(f)}
                >
                  {busy === `dl-${f.id}` ? "Downloading…" : "Restore"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {restoreMode && (
        <Modal title="Restore from backup" onClose={() => setRestoreMode(null)} wide>
          <RestorePanel
            hasLocalVault={true}
            driveClientId={config.driveClientId}
            preloaded={restoreMode.preloaded}
            onRestored={onRestored}
            onCancel={() => setRestoreMode(null)}
          />
        </Modal>
      )}
    </div>
  );
}

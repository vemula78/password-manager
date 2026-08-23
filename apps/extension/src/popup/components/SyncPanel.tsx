// Settings → Sync. Connects this device to a self-hosted sync server. Mirrors
// apps/web/src/components/SyncPane.tsx as closely as the popup shell allows — same content,
// same warnings, same "master password never leaves this device" framing.
//
// The master password is sent in the SYNC_CONNECT message to the BACKGROUND worker, which
// verifies it and derives the auth token there; the token, like the unlocked vault itself,
// never returns to this popup and is never persisted.
import { useEffect, useState } from "react";
import type { SyncStatusView } from "../../lib/messages";
import { call } from "../api";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Ask the browser for permission to talk to this origin before we ever try to fetch it — an
 * MV3 background worker cannot cross-origin fetch a user-supplied server without it, and the
 * request must run from a page with a user gesture (this click), not from the background. */
async function ensureHostPermission(serverUrl: string): Promise<boolean> {
  try {
    const origin = new URL(serverUrl).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false; // invalid URL — let the connect call surface a clearer error
  }
}

export function SyncPanel() {
  const [sync, setSync] = useState<SyncStatusView | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const refresh = async () => {
    const res = await call<{ ok: true; sync: SyncStatusView } | { ok: false; error: string }>({
      kind: "SYNC_STATUS",
    });
    if (res.ok) {
      setSync(res.sync);
      setServerUrl(res.sync.config.serverUrl);
      setAccountId(res.sync.config.accountId);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!sync) return null;
  const cfg = sync.config;

  const httpsWarning = serverUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(serverUrl);

  const connect = async () => {
    setErr("");
    if (!(await ensureHostPermission(serverUrl))) {
      setErr("Permission to reach that address was not granted — sync cannot proceed.");
      return;
    }
    setBusy(accountId.trim() ? "Connecting…" : "Creating account…");
    const res = await call<{ ok: true; sync: SyncStatusView } | { ok: false; error: string }>({
      kind: "SYNC_CONNECT",
      serverUrl: serverUrl.trim(),
      accountId: accountId.trim(),
      masterPassword: pwd,
    });
    setBusy("");
    setPwd("");
    if (res.ok) setSync(res.sync);
    else setErr(res.error);
  };

  const disable = async () => {
    const res = await call<{ ok: true; sync: SyncStatusView }>({ kind: "SYNC_DISABLE" });
    if (res.ok) setSync(res.sync);
  };

  const syncNow = async () => {
    setBusy("Syncing…");
    const res = await call<{ ok: true; sync: SyncStatusView } | { ok: false; error: string }>({
      kind: "SYNC_NOW",
    });
    setBusy("");
    if (res.ok) setSync(res.sync);
    else setErr(res.error);
  };

  return (
    <div className="card">
      <div className="section-title">Sync across devices</div>
      <p className="muted">
        Keep this vault in step with your other devices through your own server. The server
        stores only encrypted data — it can never read your passwords, and there is no account
        recovery through it. Your master password never leaves this device.
      </p>

      {!cfg.enabled && (
        <>
          <label className="field">
            <span>Sync server address</span>
            <input
              type="url"
              value={serverUrl}
              placeholder="https://vault-sync.example.in"
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </label>
          {httpsWarning && (
            <p className="warning-box">
              ⚠️ This address is not HTTPS. Anything sent over plain HTTP can be read or
              altered in transit. Use an https:// address.
            </p>
          )}
          <label className="field">
            <span>Existing account ID (leave blank to create a new one)</span>
            <input
              value={accountId}
              placeholder="from your first device's Sync settings"
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Master password</span>
            <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="current-password" />
          </label>
          {err && <p className="error">{err}</p>}
          <button
            className="btn primary"
            disabled={!serverUrl || !pwd || !!busy || httpsWarning}
            onClick={() => void connect()}
          >
            {busy || (accountId.trim() ? "Connect this device" : "Create sync account")}
          </button>
        </>
      )}

      {cfg.enabled && (
        <>
          <dl className="kv">
            <dt>Server</dt>
            <dd>{cfg.serverUrl}</dd>
            <dt>Account ID</dt>
            <dd><code>{cfg.accountId}</code></dd>
            <dt>This device</dt>
            <dd>{sync.deviceLabel}</dd>
            <dt>Last sync</dt>
            <dd>{cfg.lastSyncAt ? formatDateTime(cfg.lastSyncAt) : "not yet"}</dd>
          </dl>

          {!sync.canSync && (
            <p className="warning-box">
              ⚠️ Sync is on but this session cannot sign in yet. Lock and unlock the vault once
              — the login token is derived from your master password at unlock.
            </p>
          )}
          {cfg.lastError && <p className="warning-box">⚠️ {cfg.lastError}</p>}
          {sync.lastConflictCount > 0 && (
            <p className="warning-box">
              ⚠️ {sync.lastConflictCount} item(s) need review — changed on two devices at once.
              Both versions were kept; search for "conflicted copy" and delete the one you do
              not want.
            </p>
          )}
          {err && <p className="error">{err}</p>}

          <div className="btn-row">
            <button className="btn primary" disabled={!!busy || sync.busy} onClick={() => void syncNow()}>
              {busy || sync.busy ? "Syncing…" : "Sync now"}
            </button>
            <button className="btn" onClick={() => void disable()}>
              Turn off sync
            </button>
          </div>

          <p className="muted">
            To add another device: install the extension there (or use the web/mobile app),
            unlock with the same master password, then enter this account ID in its Sync
            settings.
          </p>
        </>
      )}
    </div>
  );
}

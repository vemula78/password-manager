// Settings → Sync. Connects this device to a self-hosted sync server.
//
// The server only ever receives ciphertext (SYNC-DESIGN.md §1). The master password is used
// here solely to derive the one-way auth token locally; it is never sent and never stored.
import { deriveAuthToken, SyncClient } from "@pw/sync";
import { useState } from "react";
import { useApp } from "../ctx";
import { formatDateTime, Warning } from "./ui";

export function SyncPane() {
  const app = useApp();
  const { store, config } = app;
  const sync = config.sync;

  const [serverUrl, setServerUrl] = useState(sync.serverUrl);
  const [accountId, setAccountId] = useState(sync.accountId);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const client = (url: string) =>
    new SyncClient({
      fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
      serverUrl: url,
      deviceId: config.deviceId,
      deviceLabel: config.deviceLabel,
    });

  const httpsWarning = serverUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(serverUrl);

  /** Create a brand-new account on this server from this device's vault. */
  const createAccount = async () => {
    setErr("");
    const reauth = await app.requestReauth(
      "Confirm your master password to set up sync. It is used only to derive a login token on this device — it is never sent to the server.",
    );
    if (!reauth) return;
    setBusy("Creating account…");
    try {
      const token = deriveAuthToken(reauth.masterPassword, store.getHeader().kdf);
      const id = await client(serverUrl).register(config.deviceLabel, token, store);
      app.updateConfig({
        sync: { ...sync, enabled: true, serverUrl: serverUrl.trim(), accountId: id, lastError: null },
      });
      setAccountId(id);
      // Hand the just-derived token to the session so the first sync can run immediately,
      // rather than making the user lock and unlock to get one.
      app.setAuthToken(token);
      app.toast("Sync account created.", "success");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  /** Point this device at an account created on another device. */
  const connectExisting = async () => {
    setErr("");
    const reauth = await app.requestReauth(
      "Confirm your master password to connect this device to your sync account.",
    );
    if (!reauth) return;
    setBusy("Connecting…");
    try {
      const c = client(serverUrl);
      const token = deriveAuthToken(reauth.masterPassword, store.getHeader().kdf);
      await c.login(accountId.trim(), token);
      app.updateConfig({
        sync: {
          ...sync,
          enabled: true,
          serverUrl: serverUrl.trim(),
          accountId: accountId.trim(),
          lastError: null,
        },
      });
      app.setAuthToken(token);
      app.toast("Connected to your sync account.", "success");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const disable = () => {
    app.updateConfig({ sync: { ...sync, enabled: false } });
    app.toast("Sync turned off. Your vault stays on this device.", "info");
  };

  return (
    <div className="card">
      <h3>Sync across devices</h3>
      <p className="muted">
        Keep this vault in step with your other devices through your own server. The server
        stores only encrypted data — it can never read your passwords, and there is no
        account recovery through it. Your master password never leaves this device.
      </p>

      {!sync.enabled && (
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
            <Warning>
              This address is not HTTPS. Anything sent over plain HTTP can be read or altered
              in transit. Use an https:// address.
            </Warning>
          )}
          <label className="field">
            <span>Existing account ID (leave blank to create a new one)</span>
            <input
              value={accountId}
              placeholder="from your first device's Sync settings"
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
          {err && <p className="error">{err}</p>}
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!serverUrl || !!busy || httpsWarning}
              onClick={() => void (accountId.trim() ? connectExisting() : createAccount())}
            >
              {busy || (accountId.trim() ? "Connect this device" : "Create sync account")}
            </button>
          </div>
        </>
      )}

      {sync.enabled && (
        <>
          <dl className="kv">
            <dt>Server</dt>
            <dd>{sync.serverUrl}</dd>
            <dt>Account ID</dt>
            <dd>
              <code>{sync.accountId}</code>{" "}
              <button className="btn small" onClick={() => void app.copyWithClear(sync.accountId, "Account ID copied")}>
                Copy
              </button>
            </dd>
            <dt>This device</dt>
            <dd>{config.deviceLabel}</dd>
            <dt>Last sync</dt>
            <dd>{sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "not yet"}</dd>
          </dl>

          {!app.authTokenB64 && (
            <Warning>
              Sync is on but this session cannot sign in yet. Lock and unlock the vault once —
              the login token is derived from your master password at unlock.
            </Warning>
          )}
          {sync.lastError && <Warning>{sync.lastError}</Warning>}
          {app.syncStatus.lastOutcome && !app.syncStatus.lastOutcome.hasRecoveryAuth && (
            <Warning>
              Recovery sign-in is not set up for this account. If you forget your master
              password, your recovery key will still open this vault, but it will not be able
              to update the sync server — you would have to reset the account there. Rotate
              your recovery key in Settings to enable it.
            </Warning>
          )}
          {app.syncStatus.lastOutcome && app.syncStatus.lastOutcome.conflicts.length > 0 && (
            <Warning>
              {app.syncStatus.lastOutcome.conflicts.length} item(s) were changed on two devices
              at once. Both versions were kept — search for “conflicted copy” and delete the
              one you do not want.
            </Warning>
          )}

          <div className="btn-row">
            <button
              className="btn primary"
              disabled={app.syncStatus.busy}
              onClick={() => void app.syncNow()}
            >
              {app.syncStatus.busy ? "Syncing…" : "Sync now"}
            </button>
            <button className="btn" onClick={disable}>
              Turn off sync
            </button>
          </div>

          <p className="muted">
            To add another device: install the app there, restore this vault from a backup or
            create it with the same master password, then enter this account ID in its Sync
            settings.
          </p>
        </>
      )}
    </div>
  );
}

// Web binding for @pw/sync: owns the SyncClient, the per-device base, and the config
// bookkeeping. Offline-first — every failure here leaves the vault fully usable locally.
import type { VaultStore } from "@pw/core";
import {
  deriveAuthToken,
  deriveRecoveryAuthToken,
  RollbackDetectedError,
  SyncAuthError,
  SyncClient,
  SyncIntegrityError,
  type SyncOutcome,
} from "@pw/sync";
import { useCallback, useRef, useState } from "react";
import type { AppConfig } from "./config";
import { loadSyncBase, saveSyncBase } from "./storage";

export interface SyncStatus {
  busy: boolean;
  lastError: string | null;
  lastOutcome: SyncOutcome | null;
}

export function useSync(
  store: VaultStore,
  config: AppConfig,
  updateConfig: (patch: Partial<AppConfig>) => void,
  toast: (msg: string, kind?: "info" | "success" | "error") => void,
  authTokenB64: string | null,
  /**
   * Replaces the in-memory auth token after a password change. Without this the app keeps
   * the OLD token, so the next re-login (session expiry, or a sync after the client was
   * rebuilt) authenticates with a credential the server no longer accepts.
   */
  onAuthToken: (token: string) => void,
) {
  const [status, setStatus] = useState<SyncStatus>({ busy: false, lastError: null, lastOutcome: null });
  const clientRef = useRef<SyncClient | null>(null);
  const inFlight = useRef(false);

  const client = useCallback((): SyncClient => {
    if (!clientRef.current) {
      clientRef.current = new SyncClient({
        fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        serverUrl: config.sync.serverUrl,
        deviceId: config.deviceId,
        deviceLabel: config.deviceLabel,
      });
    }
    return clientRef.current;
  }, [config.sync.serverUrl, config.deviceId, config.deviceLabel]);

  const syncNow = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<void> => {
      const { enabled, serverUrl, accountId } = config.sync;
      if (!enabled || !serverUrl || !accountId) return;
      if (!authTokenB64) {
        // The token is derived at unlock. If sync was switched on mid-session there is
        // nothing to authenticate with until the next unlock — say so rather than fail
        // silently on a timer.
        if (!opts.silent) toast("Lock and unlock once to finish enabling sync.", "info");
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      setStatus((s) => ({ ...s, busy: true, lastError: null }));

      try {
        const c = client();
        if (!c.isSignedIn()) await c.login(accountId, authTokenB64);

        const base = await loadSyncBase();
        const res = await c.sync(
          store,
          {
            lastSyncRev: config.sync.lastSyncRev,
            highestSeenRev: config.sync.highestSeenRev,
            lastHeaderRev: config.sync.lastHeaderRev,
          },
          base,
        );

        await saveSyncBase(res.base);
        updateConfig({
          sync: {
            ...config.sync,
            lastSyncRev: res.state.lastSyncRev,
            highestSeenRev: res.state.highestSeenRev,
            lastHeaderRev: res.state.lastHeaderRev ?? config.sync.lastHeaderRev,
            lastSyncAt: new Date().toISOString(),
            lastError: null,
          },
        });

        // Conflicts are never silent: the losing edit was preserved as a separate item and
        // the user has to be told, or they will never notice the duplicate.
        for (const conflict of res.outcome.conflicts) {
          store.log("item_conflicted", conflict.title);
        }
        for (const w of res.outcome.warnings) toast(w, "error");
        if (res.outcome.conflicts.length > 0) {
          toast(
            `${res.outcome.conflicts.length} item(s) were edited on two devices. Both versions were kept — look for "conflicted copy".`,
            "error",
          );
        }
        store.log("sync_completed");
        await store.persist();
        setStatus({ busy: false, lastError: null, lastOutcome: res.outcome });
        if (!opts.silent && res.outcome.conflicts.length === 0) {
          toast(`Synced — ${res.outcome.pulled} in, ${res.outcome.pushed} out`, "success");
        }
      } catch (err) {
        const msg =
          err instanceof SyncIntegrityError
            ? `${err.message} Nothing was changed on this device; sync will retry.`
            : err instanceof RollbackDetectedError
            ? err.message
            : err instanceof SyncAuthError
              ? "Sync sign-in failed. If you changed your master password on another device, unlock with the new one."
              : err instanceof Error
                ? err.message
                : String(err);
        store.log("sync_failed");
        await store.persist().catch(() => {});
        updateConfig({ sync: { ...config.sync, lastError: msg } });
        setStatus({ busy: false, lastError: msg, lastOutcome: null });
        if (!opts.silent) toast(msg, "error");
      } finally {
        inFlight.current = false;
      }
    },
    [store, config, updateConfig, toast, authTokenB64, client],
  );

  /**
   * Push a rotated header (master-password change) to the server, atomically with the new
   * auth verifier. Without this the server keeps the OLD header and the OLD password stays
   * valid against it, and other devices never learn about the change — the single most
   * dangerous way for a password change to half-succeed.
   *
   * Returns null if sync is off (nothing to do), otherwise throws on failure so the caller
   * can tell the user their password changed locally but NOT on the server.
   */
  const pushHeaderNow = useCallback(
    async (newMasterPassword: string): Promise<void | null> => {
      const { enabled, serverUrl, accountId } = config.sync;
      if (!enabled || !serverUrl || !accountId) return null;

      const c = client();
      const newToken = deriveAuthToken(newMasterPassword, store.getHeader().kdf);
      if (!c.isSignedIn()) {
        // Sign in with the OLD token — the server has not rotated yet.
        if (!authTokenB64) throw new SyncAuthError("Not signed in to the sync server.");
        await c.login(accountId, authTokenB64);
      }
      const res = await c.pushHeader(
        store,
        {
          lastSyncRev: config.sync.lastSyncRev,
          highestSeenRev: config.sync.highestSeenRev,
          lastHeaderRev: config.sync.lastHeaderRev,
        },
        { newAuthTokenB64: newToken },
      );
      updateConfig({
        sync: { ...config.sync, lastHeaderRev: res.state.lastHeaderRev ?? 0, lastError: null },
      });
      onAuthToken(newToken);
      return;
    },
    [store, config, updateConfig, authTokenB64, client, onAuthToken],
  );

  /**
   * Register the server-side recovery verifier after the recovery key is created or rotated
   * (SYNC-DESIGN.md §4). The rotation already changed the recovery envelopes in the header,
   * so both travel in one compare-and-set push.
   *
   * This is the ONLY moment the recovery key's bytes exist — they cannot be recovered from
   * the header later. Skip it and recovery sign-in stays unavailable for this account, which
   * is exactly the lockout this whole mechanism exists to prevent.
   *
   * Returns null when sync is off; otherwise throws so the caller can surface the failure.
   */
  const pushRecoveryVerifier = useCallback(
    async (recoveryKeyText: string): Promise<void | null> => {
      const { enabled, serverUrl, accountId } = config.sync;
      if (!enabled || !serverUrl || !accountId) return null;

      const c = client();
      if (!c.isSignedIn()) {
        if (!authTokenB64) throw new SyncAuthError("Not signed in to the sync server.");
        await c.login(accountId, authTokenB64);
      }
      const res = await c.pushHeader(
        store,
        {
          lastSyncRev: config.sync.lastSyncRev,
          highestSeenRev: config.sync.highestSeenRev,
          lastHeaderRev: config.sync.lastHeaderRev,
        },
        { newRecoveryAuthTokenB64: deriveRecoveryAuthToken(recoveryKeyText) },
      );
      updateConfig({
        sync: { ...config.sync, lastHeaderRev: res.state.lastHeaderRev ?? 0, lastError: null },
      });
      return;
    },
    [store, config, updateConfig, authTokenB64, client],
  );

  return { status, syncNow, pushHeaderNow, pushRecoveryVerifier };
}

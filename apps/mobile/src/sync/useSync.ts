// Mobile binding for @pw/sync, mirroring apps/web/src/lib/sync.ts: owns the SyncClient, the
// per-device base, and the config bookkeeping. Offline-first — every failure here leaves the
// vault fully usable locally.
import { useCallback, useRef, useState } from "react";
import type { VaultStore } from "@pw/core";
import {
  RollbackDetectedError,
  SyncAuthError,
  SyncClient,
  deriveAuthToken,
  type SyncOutcome,
} from "@pw/sync";
import type { SyncIdentity } from "./config";
import { loadSyncBase, saveSyncBase } from "./base";

export interface SyncStatus {
  busy: boolean;
  lastError: string | null;
  lastOutcome: SyncOutcome | null;
}

export function useSync(
  store: VaultStore | null,
  identity: SyncIdentity,
  updateSyncConfig: (patch: Partial<SyncIdentity["sync"]>) => void,
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
  const clientServerUrl = useRef<string>("");
  const inFlight = useRef(false);

  const client = useCallback((): SyncClient => {
    if (!clientRef.current || clientServerUrl.current !== identity.sync.serverUrl) {
      clientRef.current = new SyncClient({
        fetch: fetch as unknown as typeof fetch,
        serverUrl: identity.sync.serverUrl,
        deviceId: identity.deviceId,
        deviceLabel: identity.deviceLabel,
      });
      clientServerUrl.current = identity.sync.serverUrl;
    }
    return clientRef.current;
  }, [identity.sync.serverUrl, identity.deviceId, identity.deviceLabel]);

  const syncNow = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<void> => {
      const { enabled, serverUrl, accountId } = identity.sync;
      if (!enabled || !serverUrl || !accountId || !store) return;
      if (!authTokenB64) {
        // The token is derived at unlock. If sync was switched on mid-session there is
        // nothing to authenticate with until the next unlock — say so rather than fail
        // silently on a timer.
        setStatus((s) => (opts.silent ? s : { ...s, lastError: "Lock and unlock once to finish enabling sync." }));
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      setStatus((s) => ({ ...s, busy: true, lastError: null }));

      try {
        const c = client();
        if (!c.isSignedIn()) await c.login(accountId, authTokenB64);

        const base = loadSyncBase();
        const res = await c.sync(
          store,
          {
            lastSyncRev: identity.sync.lastSyncRev,
            highestSeenRev: identity.sync.highestSeenRev,
            lastHeaderRev: identity.sync.lastHeaderRev,
          },
          base,
        );

        saveSyncBase(res.base);
        updateSyncConfig({
          lastSyncRev: res.state.lastSyncRev,
          highestSeenRev: res.state.highestSeenRev,
          lastHeaderRev: res.state.lastHeaderRev ?? identity.sync.lastHeaderRev,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
        });

        // Conflicts are never silent: the losing edit was preserved as a separate item and
        // the user has to be told, or they will never notice the duplicate.
        for (const conflict of res.outcome.conflicts) {
          store.log("item_conflicted", conflict.title);
        }
        store.log("sync_completed");
        await store.persist();
        setStatus({ busy: false, lastError: null, lastOutcome: res.outcome });
      } catch (err) {
        const msg =
          err instanceof RollbackDetectedError
            ? err.message
            : err instanceof SyncAuthError
              ? "Sync sign-in failed. If you changed your master password on another device, unlock with the new one."
              : err instanceof Error
                ? err.message
                : String(err);
        store.log("sync_failed");
        await store.persist().catch(() => {});
        updateSyncConfig({ lastError: msg });
        setStatus({ busy: false, lastError: msg, lastOutcome: null });
      } finally {
        inFlight.current = false;
      }
    },
    [store, identity, updateSyncConfig, authTokenB64, client],
  );

  /**
   * Push a rotated header (master-password change) to the server, atomically with the new
   * auth verifier. Mirrors apps/web/src/lib/sync.ts. Without this the server keeps the OLD
   * header, the OLD password stays valid against it, and other devices never learn about
   * the change — the single most dangerous way for a password change to half-succeed.
   *
   * Returns null when sync is off (nothing to do); otherwise throws on failure so the caller
   * can tell the user the password changed locally but NOT on the server.
   */
  const pushHeaderNow = useCallback(
    async (newMasterPassword: string): Promise<void | null> => {
      const { enabled, serverUrl, accountId } = identity.sync;
      if (!enabled || !serverUrl || !accountId || !store) return null;

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
          lastSyncRev: identity.sync.lastSyncRev,
          highestSeenRev: identity.sync.highestSeenRev,
          lastHeaderRev: identity.sync.lastHeaderRev,
        },
        newToken,
      );
      updateSyncConfig({ lastHeaderRev: res.state.lastHeaderRev ?? 0, lastError: null });
      onAuthToken(newToken);
      return;
    },
    [store, identity, updateSyncConfig, authTokenB64, client, onAuthToken],
  );

  return { status, syncNow, pushHeaderNow };
}

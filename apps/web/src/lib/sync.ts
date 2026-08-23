// Web binding for @pw/sync: owns the SyncClient, the per-device base, and the config
// bookkeeping. Offline-first — every failure here leaves the vault fully usable locally.
import type { VaultStore } from "@pw/core";
import {
  RollbackDetectedError,
  SyncAuthError,
  SyncClient,
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
          { lastSyncRev: config.sync.lastSyncRev, highestSeenRev: config.sync.highestSeenRev },
          base,
        );

        await saveSyncBase(res.base);
        updateConfig({
          sync: {
            ...config.sync,
            lastSyncRev: res.state.lastSyncRev,
            highestSeenRev: res.state.highestSeenRev,
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
          err instanceof RollbackDetectedError
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

  return { status, syncNow };
}

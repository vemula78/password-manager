// Bringing the sync server along after a recovery-key unlock. Mirrors the web shell's
// pushRecoveredHeader in apps/web/src/components/PostRecoveryFlow.tsx.
//
// A recovering device has no KEK and therefore no password credential, so it signs in with
// the recovery-derived verifier instead (SYNC-DESIGN.md §4) and pushes the rewrapped header
// together with the new password verifier, atomically. Without this the server keeps the OLD
// header, the OLD master password goes on working against it, and every other device stays
// stranded — see NOTES/post-recovery-sync-gap.md.
import type { VaultStore } from "@pw/core";
import { SyncClient, deriveAuthToken, deriveRecoveryAuthToken } from "@pw/sync";
import { loadSyncConfig, saveSyncConfig } from "./config";

/**
 * Returns a message to show the user when it could not be done, or null on success (or when
 * there is nothing to do). Never throws: the local password change has already happened and
 * must not be reported as failed.
 */
export async function pushRecoveredHeader(
  store: VaultStore,
  recoveryKey: string,
  newPassword: string,
  newRecoveryKey?: string,
): Promise<string | null> {
  const cfg = loadSyncConfig();
  if (!cfg.sync.enabled || !cfg.sync.serverUrl || !cfg.sync.accountId) return null;

  try {
    const client = new SyncClient({
      fetch: fetch as unknown as typeof fetch,
      serverUrl: cfg.sync.serverUrl,
      deviceId: cfg.deviceId,
      deviceLabel: cfg.deviceLabel,
    });
    await client.loginWithRecovery(cfg.sync.accountId, deriveRecoveryAuthToken(recoveryKey));
    const res = await client.pushHeader(
      store,
      {
        lastSyncRev: cfg.sync.lastSyncRev,
        highestSeenRev: cfg.sync.highestSeenRev,
        lastHeaderRev: cfg.sync.lastHeaderRev,
      },
      {
        newAuthTokenB64: deriveAuthToken(newPassword, store.getHeader().kdf),
        ...(newRecoveryKey !== undefined
          ? { newRecoveryAuthTokenB64: deriveRecoveryAuthToken(newRecoveryKey) }
          : {}),
      },
    );
    const fresh = loadSyncConfig();
    saveSyncConfig({
      ...fresh,
      sync: { ...fresh.sync, lastHeaderRev: res.state.lastHeaderRev ?? 0, lastError: null },
    });
    return null;
  } catch (e) {
    const msg =
      "Your master password was changed on this device, but the sync server could not be " +
      "updated: " +
      (e instanceof Error ? e.message : String(e)) +
      " Your old password still works for sync until this succeeds. If this account has no " +
      "recovery credential registered, reset it on the sync server and connect again.";
    const fresh = loadSyncConfig();
    saveSyncConfig({ ...fresh, sync: { ...fresh.sync, lastError: msg } });
    return msg;
  }
}

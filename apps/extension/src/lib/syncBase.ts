// The sync base: item id -> that item's updatedAt at the last successful sync. Kept OUT of
// the vault file and per-device — it must never sync, because it is how the merge engine
// tells "I changed this" from "they never changed it" (mirrors apps/web/src/lib/storage.ts's
// loadSyncBase/saveSyncBase).
//
// Contains no secrets — only opaque item ids and edit timestamps, both of which the sync
// server necessarily sees anyway. Still kept in ordinary chrome.storage.local, same store as
// the encrypted vault blob it describes, never chrome.storage.sync.
import type { SyncBase } from "@pw/sync";

const K_SYNC_BASE = "pwmext.syncBase";

export async function loadSyncBase(): Promise<SyncBase> {
  const v = await chrome.storage.local.get(K_SYNC_BASE);
  const stored = v[K_SYNC_BASE];
  return stored && typeof stored === "object" ? (stored as SyncBase) : {};
}

export async function saveSyncBase(base: SyncBase): Promise<void> {
  await chrome.storage.local.set({ [K_SYNC_BASE]: base });
}

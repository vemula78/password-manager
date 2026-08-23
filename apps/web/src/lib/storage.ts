// IndexedDB storage for the encrypted vault blob. The blob handed to us by @pw/core is
// already encrypted (header + per-item ciphertexts); we never store anything vault-related
// in localStorage.
import type { StorageAdapter } from "@pw/core";
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "pwm";
const STORE = "vault";
const KEY = "vault";
// Per-device sync bookkeeping. Kept OUT of the vault file because it must not sync: each
// device has its own view of "what the server and I last agreed on".
const SYNC_STORE = "sync";
const BASE_KEY = "syncBase";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) d.createObjectStore(STORE);
        if (oldVersion < 2) d.createObjectStore(SYNC_STORE);
      },
    });
  }
  return dbPromise;
}

export async function loadVaultBlob(): Promise<string | null> {
  const v = await (await db()).get(STORE, KEY);
  return typeof v === "string" ? v : null;
}

export async function saveVaultBlob(serialized: string): Promise<void> {
  await (await db()).put(STORE, serialized, KEY);
}

export async function deleteVaultBlob(): Promise<void> {
  await (await db()).delete(STORE, KEY);
}

/**
 * The sync base: item id → that item's updatedAt at the last successful sync. It is how the
 * merge distinguishes "I edited this" from "they edited this", which is what stops every
 * first sync after an edit from manufacturing a spurious conflict copy.
 *
 * Contains NO secrets — only opaque ids and edit timestamps, both of which the sync server
 * necessarily sees anyway. No field values, titles, or passwords. It is still kept in
 * IndexedDB rather than localStorage, alongside the encrypted vault it describes.
 */
export async function loadSyncBase(): Promise<Record<string, string>> {
  const v = await (await db()).get(SYNC_STORE, BASE_KEY);
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}

export async function saveSyncBase(base: Record<string, string>): Promise<void> {
  await (await db()).put(SYNC_STORE, base, BASE_KEY);
}

export async function clearSyncBase(): Promise<void> {
  await (await db()).delete(SYNC_STORE, BASE_KEY);
}

/** StorageAdapter for @pw/core's VaultStore. */
export const idbAdapter: StorageAdapter = {
  save: saveVaultBlob,
};

// IndexedDB storage for the encrypted vault blob. The blob handed to us by @pw/core is
// already encrypted (header + per-item ciphertexts); we never store anything vault-related
// in localStorage.
import type { StorageAdapter } from "@pw/core";
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "pwm";
const STORE = "vault";
const KEY = "vault";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore(STORE);
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

/** StorageAdapter for @pw/core's VaultStore. */
export const idbAdapter: StorageAdapter = {
  save: saveVaultBlob,
};

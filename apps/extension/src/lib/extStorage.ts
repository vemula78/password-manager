// chrome.storage.local wrappers. Only ciphertext (the serialized vault blob) and small
// non-sensitive numbers/counters ever land here — never keys, never plaintext vault data.
// See NOTES/shell-review-findings.md pattern #2: every unlock-equivalent path (including
// backup import, which is what this shell uses instead of a live vault) must share the
// unlock screen's failed-attempt backoff.
import type { StorageAdapter } from "@pw/core";
import { INITIAL_BACKOFF, type UnlockBackoffState } from "./backoff";

const K_VAULT_BLOB = "pwmext.vaultBlob";
const K_BACKOFF = "pwmext.backoff";
const K_PREFS = "pwmext.prefs"; // non-sensitive cached copy of autoLockMinutes/clipboardClearSeconds

export interface ExtPrefs {
  autoLockMinutes: number;
  clipboardClearSeconds: number;
}

export const DEFAULT_PREFS: ExtPrefs = { autoLockMinutes: 5, clipboardClearSeconds: 30 };

export async function loadVaultBlob(): Promise<string | null> {
  const v = await chrome.storage.local.get(K_VAULT_BLOB);
  return typeof v[K_VAULT_BLOB] === "string" ? (v[K_VAULT_BLOB] as string) : null;
}

export async function saveVaultBlob(serialized: string): Promise<void> {
  await chrome.storage.local.set({ [K_VAULT_BLOB]: serialized });
}

/** StorageAdapter for @pw/core's VaultStore — every mutation re-persists the ciphertext here. */
export const extStorageAdapter: StorageAdapter = {
  save: saveVaultBlob,
};

export async function loadBackoff(): Promise<UnlockBackoffState> {
  const v = await chrome.storage.local.get(K_BACKOFF);
  const stored = v[K_BACKOFF] as Partial<UnlockBackoffState> | undefined;
  return { ...INITIAL_BACKOFF, ...stored };
}

export async function saveBackoff(state: UnlockBackoffState): Promise<void> {
  await chrome.storage.local.set({ [K_BACKOFF]: state });
}

export async function loadPrefs(): Promise<ExtPrefs> {
  const v = await chrome.storage.local.get(K_PREFS);
  return { ...DEFAULT_PREFS, ...(v[K_PREFS] as Partial<ExtPrefs> | undefined) };
}

export async function savePrefs(prefs: ExtPrefs): Promise<void> {
  await chrome.storage.local.set({ [K_PREFS]: prefs });
}

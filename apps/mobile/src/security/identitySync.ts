// Keeps iOS's ASCredentialIdentityStore (the QuickType bar's source of truth) in sync with the
// vault's Login items. Call this whenever the item list changes (add/edit/delete/archive) or
// right after unlock/import — see apps/mobile/src/vault/VaultContext.tsx's `refresh()` and the
// post-unlock/create/adopt call sites. No-op on Android/web.
import { Platform } from "react-native";
import type { VaultStore } from "@pw/core";
import SharedVaultStore from "../../modules/shared-vault-store/src/SharedVaultStoreModule";

/** Same hostname-extraction rule as apps/extension/src/lib/domain.ts's extractHost. */
function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Push the current set of Login items (only type "login", only those with both a url and a
 * username) into ASCredentialIdentityStore. NEVER includes netbanking/upi/card/demat/govid/
 * note/wifi/insurance/custom items — those have no place in the system AutoFill picker.
 * Swallows errors (missing native module / entitlement) so this never breaks the caller's flow.
 */
export async function syncCredentialIdentities(store: VaultStore | null): Promise<void> {
  if (Platform.OS !== "ios" || !store) return;
  try {
    const items = store
      .listItems()
      .filter((item) => item.type === "login")
      .map((item) => {
        const username = item.fields.username;
        const host = item.fields.url ? extractHost(item.fields.url) : null;
        return username && host ? { id: item.id, username, host } : null;
      })
      .filter((x): x is { id: string; username: string; host: string } => x !== null);
    await SharedVaultStore.syncCredentialIdentities(items);
  } catch {
    // Missing entitlement, native module unavailable (e.g. Expo Go), or the OS call itself
    // failed — the QuickType bar just won't reflect the latest items until the next sync.
  }
}

/**
 * Wipes ASCredentialIdentityStore — call as part of the biometrics/AutoFill disable flow so
 * the QuickType bar stops offering hostnames for a vault the extension can no longer decrypt
 * (its shared Vault Key was just revoked). Bypasses syncCredentialIdentities' `store` gate
 * since there's nothing to read from when explicitly clearing.
 */
export async function clearCredentialIdentities(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await SharedVaultStore.syncCredentialIdentities([]);
  } catch {
    // Missing entitlement or native module unavailable — nothing more to do.
  }
}

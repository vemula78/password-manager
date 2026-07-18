import { NativeModule, requireNativeModule } from "expo";

import type { CredentialIdentityInput } from "./SharedVaultStore.types";

declare class SharedVaultStoreModule extends NativeModule<{}> {
  /** Writes the raw 32-byte Vault Key (base64) into a Face ID/passcode-gated shared Keychain item. */
  storeSharedVaultKey(vaultKeyBase64: string): Promise<void>;
  /** Deletes the shared Keychain vault-key item, if present. */
  deleteSharedVaultKey(): Promise<void>;
  /** Replaces the ASCredentialIdentityStore contents so the QuickType bar reflects `items`. */
  syncCredentialIdentities(items: CredentialIdentityInput[]): Promise<void>;
  /**
   * Writes `contents` to the file at `fileUri` via NSFileCoordinator (coordinated, atomic
   * replace) — iOS only. Used by storage.ts's save() for the shared-container vault file so
   * the main app's writes are coordinated with the credentials-provider extension's reads/
   * writes at the OS level, instead of a plain, uncoordinated File.write().
   */
  writeVaultFileCoordinated(fileUri: string, contents: string): Promise<void>;
}

export default requireNativeModule<SharedVaultStoreModule>("SharedVaultStore");
export type { CredentialIdentityInput };

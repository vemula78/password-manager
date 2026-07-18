import { registerWebModule, NativeModule } from "expo";

import type { CredentialIdentityInput } from "./SharedVaultStore.types";

// AutoFill credential providers and App Groups are an iOS-only concept. This web stub exists
// only so `apps/mobile` still type-checks and bundles for the web target; every method throws
// if actually invoked there — callers (storage.ts, biometric.ts, identitySync.ts) branch on
// Platform.OS === "ios" before calling into this module, so these should never run on web.
class SharedVaultStoreModule extends NativeModule<{}> {
  async storeSharedVaultKey(_vaultKeyBase64: string): Promise<void> {
    throw new Error("SharedVaultStore is not available on web.");
  }
  async deleteSharedVaultKey(): Promise<void> {
    throw new Error("SharedVaultStore is not available on web.");
  }
  async syncCredentialIdentities(_items: CredentialIdentityInput[]): Promise<void> {
    throw new Error("SharedVaultStore is not available on web.");
  }
  async writeVaultFileCoordinated(_fileUri: string, _contents: string): Promise<void> {
    throw new Error("SharedVaultStore is not available on web.");
  }
}

export default registerWebModule(SharedVaultStoreModule, "SharedVaultStoreModule");

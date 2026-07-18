package expo.modules.sharedvaultstore

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// App Groups / ASCredentialIdentityStore are iOS-only concepts (see the AutoFill credential
// provider extension under apps/mobile/targets/credentials-provider). All JS call sites
// (storage.ts, biometric.ts, identitySync.ts) branch on Platform.OS === "ios" before calling
// into this module, so these methods should never actually run on Android — they throw rather
// than silently no-op so a missed Platform check fails loudly instead of corrupting state.
class SharedVaultStoreModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SharedVaultStore")

    AsyncFunction("storeSharedVaultKey") { _: String ->
      throw NotImplementedError("SharedVaultStore is iOS-only.")
    }

    AsyncFunction("deleteSharedVaultKey") {
      throw NotImplementedError("SharedVaultStore is iOS-only.")
    }

    AsyncFunction("syncCredentialIdentities") { _: List<Map<String, String>> ->
      throw NotImplementedError("SharedVaultStore is iOS-only.")
    }

    AsyncFunction("writeVaultFileCoordinated") { _: String, _: String ->
      throw NotImplementedError("SharedVaultStore is iOS-only.")
    }
  }
}

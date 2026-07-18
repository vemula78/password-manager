import ExpoModulesCore
import AuthenticationServices
import Security

// Must match app.json's expo.ios.entitlements["com.apple.security.application-groups"][0]
// and targets/credentials-provider/expo-target.config.js's app-groups entry exactly.
let pwmAppGroupId = "group.org.pwmanager.vault"

// Keychain item that holds the raw 32-byte Vault Key (VK), gated behind Face ID/Touch ID/
// passcode. Shared (via kSecAttrAccessGroup) with the credentials-provider extension so it can
// decrypt items without re-deriving the KEK from the master password.
private let pwmVaultKeyService = "org.pwmanager.vault.sharedvaultkey"
private let pwmVaultKeyAccount = "vaultKey"

final class InvalidVaultKeyError: Exception {
  override var reason: String { "Vault key was not valid base64." }
}

final class KeychainAccessControlError: Exception {
  override var reason: String { "Could not create a SecAccessControl for the shared vault key." }
}

final class KeychainWriteError: Exception {
  let status: OSStatus
  init(_ status: OSStatus) {
    self.status = status
    super.init()
  }
  override var reason: String { "Keychain write failed (OSStatus \(status))." }
}

final class KeychainDeleteError: Exception {
  let status: OSStatus
  init(_ status: OSStatus) {
    self.status = status
    super.init()
  }
  override var reason: String { "Keychain delete failed (OSStatus \(status))." }
}

final class InvalidVaultFileURLError: Exception {
  override var reason: String { "Vault file URI was not a valid file:// URL." }
}

final class VaultWriteEncodingError: Exception {
  override var reason: String { "Vault contents could not be encoded as UTF-8." }
}

final class CoordinatedWriteError: Exception {
  let underlying: String
  init(_ underlying: String) {
    self.underlying = underlying
    super.init()
  }
  override var reason: String { "Coordinated vault write failed: \(underlying)" }
}

public class SharedVaultStoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SharedVaultStore")

    // NOTE: the shared container *path* itself is not exposed here — expo-file-system (57.x)
    // already exposes it natively via `Paths.appleSharedContainers["group.org.pwmanager.vault"]`
    // (see FileSystemModule.swift's "appleSharedContainers" constant), which returns a properly
    // formed `file://` URI ready to hand to `new Directory(...)`. storage.ts uses that instead
    // of reinventing it here. This module covers the two things with no existing Expo API:
    // Keychain access-group writes, and ASCredentialIdentityStore sync.

    AsyncFunction("storeSharedVaultKey") { (vaultKeyBase64: String) in
      try SharedVaultStoreModule.storeVaultKey(vaultKeyBase64)
    }

    AsyncFunction("deleteSharedVaultKey") {
      try SharedVaultStoreModule.deleteVaultKey()
    }

    // items: [{ id, username, host }] — ONLY "login" items with both a url and username;
    // filtering happens in JS (apps/mobile/src/security/identitySync.ts) before this is called.
    AsyncFunction("syncCredentialIdentities") { (items: [[String: String]]) in
      SharedVaultStoreModule.syncIdentities(items)
    }

    // Coordinated, atomic write of the shared-container vault file — used by storage.ts's
    // save() on iOS instead of a plain File.write(), so the main app becomes a proper
    // NSFileCoordinator participant. This makes its writes mutually exclusive at the OS level
    // with the credentials-provider extension's own coordinated reads/writes (VaultAccess.swift),
    // closing the non-atomic-write / rollback gap a plain write() has.
    AsyncFunction("writeVaultFileCoordinated") { (fileUri: String, contents: String) in
      try SharedVaultStoreModule.writeVaultFileCoordinated(fileUri: fileUri, contents: contents)
    }
  }

  private static func storeVaultKey(_ base64: String) throws {
    guard let data = Data(base64Encoded: base64) else { throw InvalidVaultKeyError() }

    // Overwrite semantics: delete any existing item first so re-enabling biometrics after a
    // vault-key rotation (there isn't one today, but this keeps the invariant obvious) can't
    // leave a stale item behind.
    try deleteVaultKey()

    var accessError: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        .userPresence,  // Face ID / Touch ID / device passcode — mirrors biometric.ts's SecureStore item
        &accessError
      )
    else {
      throw KeychainAccessControlError()
    }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: pwmVaultKeyService,
      kSecAttrAccount as String: pwmVaultKeyAccount,
      kSecAttrAccessGroup as String: pwmAppGroupId,
      kSecValueData as String: data,
      kSecAttrAccessControl as String: access,
    ]
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainWriteError(status)
    }
  }

  private static func deleteVaultKey() throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: pwmVaultKeyService,
      kSecAttrAccount as String: pwmVaultKeyAccount,
      kSecAttrAccessGroup as String: pwmAppGroupId,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainDeleteError(status)
    }
  }

  /// Writes `contents` to the file at `fileUri` via `NSFileCoordinator.coordinate(writingItemAt:
  /// options: .forReplacing)` + an atomic write, so the main app's vault-file saves are
  /// coordinated (mutually exclusive with the extension's own coordinated reads/writes) rather
  /// than a plain, uncoordinated `File.write()`.
  private static func writeVaultFileCoordinated(fileUri: String, contents: String) throws {
    guard let url = URL(string: fileUri), url.isFileURL else {
      throw InvalidVaultFileURLError()
    }
    guard let data = contents.data(using: .utf8) else {
      throw VaultWriteEncodingError()
    }
    var coordinatorError: NSError?
    var writeError: Error?
    let coordinator = NSFileCoordinator(filePresenter: nil)
    coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinatorError) {
      writeURL in
      do {
        try data.write(to: writeURL, options: .atomic)
      } catch {
        writeError = error
      }
    }
    if let coordinatorError {
      throw CoordinatedWriteError(coordinatorError.localizedDescription)
    }
    if let writeError {
      throw CoordinatedWriteError(writeError.localizedDescription)
    }
  }

  private static func syncIdentities(_ items: [[String: String]]) {
    let identities: [ASPasswordCredentialIdentity] = items.compactMap { item in
      guard let id = item["id"], let username = item["username"], let host = item["host"],
        !host.isEmpty, !username.isEmpty
      else { return nil }
      let serviceId = ASCredentialServiceIdentifier(identifier: host, type: .domain)
      return ASPasswordCredentialIdentity(
        serviceIdentifier: serviceId, user: username, recordIdentifier: id)
    }
    ASCredentialIdentityStore.shared.replaceCredentialIdentities(with: identities) { success, error
      in
      if let error = error {
        print("[SharedVaultStore] Failed to sync credential identities: \(error)")
      } else if !success {
        print("[SharedVaultStore] replaceCredentialIdentities reported failure with no error")
      }
    }
  }
}

import Foundation
import Sodium
import Security

// Reads the shared vault.json, unlocks it with the Vault Key (VK) from the shared Keychain item
// (Face ID/passcode-gated via SecAccessControl — see modules/shared-vault-store's
// storeSharedVaultKey), decrypts Login items, and appends "autofill_used" audit events.
//
// Ciphertext format MUST match packages/core/src/crypto.ts exactly:
//   - XChaCha20-Poly1305 (IETF, combined mode: ciphertext includes the Poly1305 tag)
//   - nonce: 24 random bytes (crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
//   - base64: standard, padded (libsodium's base64_variants.ORIGINAL == Foundation's default
//     Data(base64Encoded:) / .base64EncodedString())
//   - associated data for an item: "item:" + id (packages/core/src/vault.ts's `adItem`)
//   - associated data for the audit log: "audit:v1" (packages/core/src/vault.ts's `AD_AUDIT`)
enum VaultAccess {
  // Must match app.json / expo-target.config.js's app-groups entry exactly.
  static let appGroupId = "group.org.pwmanager.vault"
  static let vaultKeyService = "org.pwmanager.vault.sharedvaultkey"
  static let vaultKeyAccount = "vaultKey"
  static let vaultFileName = "vault.json"

  private static let sodium = Sodium()

  enum AccessError: Error {
    case containerUnavailable
    case vaultFileMissing
    case vaultKeyUnavailable(OSStatus)
    case malformedVault
    case decryptFailed
    /// The vault's `audit` field is present but failed to decrypt/parse — a sign of tampering
    /// or corruption, not "no audit log yet". Callers must abort rather than overwrite it.
    case auditIntegrityFailure
  }

  static func containerURL() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
  }

  static func vaultFileURL() throws -> URL {
    guard let container = containerURL() else { throw AccessError.containerUnavailable }
    return container.appendingPathComponent(vaultFileName)
  }

  /// Reads the raw 32-byte Vault Key from the shared Keychain item. Because the item's
  /// SecAccessControl requires `.userPresence`, this call triggers the system Face ID/passcode
  /// prompt itself — `allowUI` controls whether that's permitted (it must be, for both
  /// `prepareCredentialList` and `provideCredentialWithoutUserInteraction`; Apple explicitly
  /// allows `kSecUseAuthenticationUIAllow` in the latter so QuickType-bar taps can prompt Face
  /// ID inline instead of always falling back to the interactive extension UI).
  static func readVaultKey(allowUI: Bool) throws -> [UInt8] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: vaultKeyService,
      kSecAttrAccount as String: vaultKeyAccount,
      kSecAttrAccessGroup as String: appGroupId,
      kSecReturnData as String: true,
      kSecUseAuthenticationUI as String: allowUI
        ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
      throw AccessError.vaultKeyUnavailable(status)
    }
    return [UInt8](data)
  }

  /// Reads the vault file with NSFileCoordinator so we never observe a half-written file while
  /// the main app is mid-`persist()` (see NOTES/ios-autofill-setup.md's file-coordination note).
  private static func coordinatedRead(_ url: URL) throws -> Data {
    var coordinatorError: NSError?
    var result: Data?
    var readError: Error?
    let coordinator = NSFileCoordinator(filePresenter: nil)
    coordinator.coordinate(readingItemAt: url, options: [], error: &coordinatorError) { readURL in
      do {
        result = try Data(contentsOf: readURL)
      } catch {
        readError = error
      }
    }
    if let coordinatorError { throw coordinatorError }
    if let readError { throw readError }
    guard let result else { throw AccessError.vaultFileMissing }
    return result
  }

  struct LoginCandidate {
    let id: String
    let title: String
    let username: String
    let password: String
    let host: String
  }

  private static func decryptCiphertext(
    ctDict: [String: Any], key: [UInt8], ad: String
  ) -> Data? {
    guard let nonceB64 = ctDict["nonceB64"] as? String,
      let ctB64 = ctDict["ctB64"] as? String,
      let nonce = Data(base64Encoded: nonceB64),
      let ct = Data(base64Encoded: ctB64)
    else { return nil }
    guard
      let plaintext = sodium.aead.xchacha20poly1305ietf.decrypt(
        authenticatedCipherText: [UInt8](ct),
        secretKey: key,
        nonce: [UInt8](nonce),
        additionalData: Array(ad.utf8)
      )
    else { return nil }
    return Data(plaintext)
  }

  private static func encryptForAudit(_ plaintext: Data, key: [UInt8]) -> [String: String]? {
    guard
      let result = sodium.aead.xchacha20poly1305ietf.encrypt(
        message: [UInt8](plaintext),
        secretKey: key,
        additionalData: Array("audit:v1".utf8)
      )
    else { return nil }
    return [
      "nonceB64": Data(result.nonce).base64EncodedString(),
      "ctB64": Data(result.authenticatedCipherText).base64EncodedString(),
    ]
  }

  /// Loads and decrypts every Login item (only `type == "login"`, not archived) whose stored
  /// host matches ANY of `requestedHosts` per DomainMatch's asymmetric rule. Returns the raw
  /// Vault Key too (callers need it again to append the audit event after a selection).
  ///
  /// `requestedHosts` must already be canonicalized (see `DomainMatch.canonicalHost(from:)`) —
  /// callers should map every `ASCredentialServiceIdentifier` iOS provides through that, not
  /// just the first one, and not the raw `.identifier` string.
  static func loadMatchingLogins(
    requestedHosts: [String], allowUI: Bool
  ) throws -> (matches: [LoginCandidate], vaultKey: [UInt8], vaultJSON: [String: Any], fileURL: URL)
  {
    let fileURL = try vaultFileURL()
    let raw = try coordinatedRead(fileURL)
    guard
      let top = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
      let itemsArray = top["items"] as? [[String: Any]]
    else { throw AccessError.malformedVault }

    let vk = try readVaultKey(allowUI: allowUI)

    var matches: [LoginCandidate] = []
    for entry in itemsArray {
      guard let id = entry["id"] as? String, let ctDict = entry["ct"] as? [String: Any] else {
        continue
      }
      guard let plaintext = decryptCiphertext(ctDict: ctDict, key: vk, ad: "item:\(id)") else {
        continue  // tampered/corrupt entry — skip rather than fail the whole list
      }
      guard let item = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
      else { continue }
      guard (item["type"] as? String) == "login" else { continue }
      if (item["archived"] as? Bool) == true { continue }
      guard let fields = item["fields"] as? [String: Any],
        let username = fields["username"] as? String, !username.isEmpty,
        let urlField = fields["url"] as? String,
        let storedHost = DomainMatch.extractHost(fromStoredUrl: urlField)
      else { continue }
      let matchesAny = requestedHosts.contains { requestedHost in
        let match = DomainMatch.compareHosts(requestedHost: requestedHost, storedHost: storedHost)
        return match == .exact || match == .subdomain
      }
      guard matchesAny else { continue }
      let password = (fields["password"] as? String) ?? ""
      let title = (item["title"] as? String) ?? username
      matches.append(
        LoginCandidate(id: id, title: title, username: username, password: password, host: storedHost)
      )
    }
    return (matches, vk, top, fileURL)
  }

  /// Decrypts and returns a single item by id (for `provideCredentialWithoutUserInteraction`,
  /// which already knows the recordIdentifier and shouldn't have to scan by host).
  static func loadItem(byId id: String, allowUI: Bool) throws -> (
    candidate: LoginCandidate, vaultKey: [UInt8], vaultJSON: [String: Any], fileURL: URL
  ) {
    let fileURL = try vaultFileURL()
    let raw = try coordinatedRead(fileURL)
    guard
      let top = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
      let itemsArray = top["items"] as? [[String: Any]],
      let entry = itemsArray.first(where: { ($0["id"] as? String) == id }),
      let ctDict = entry["ct"] as? [String: Any]
    else { throw AccessError.malformedVault }

    let vk = try readVaultKey(allowUI: allowUI)
    guard let plaintext = decryptCiphertext(ctDict: ctDict, key: vk, ad: "item:\(id)"),
      let item = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
      (item["type"] as? String) == "login",
      (item["archived"] as? Bool) != true,
      let fields = item["fields"] as? [String: Any],
      let username = fields["username"] as? String
    else { throw AccessError.decryptFailed }
    let password = (fields["password"] as? String) ?? ""
    let title = (item["title"] as? String) ?? username
    let host = (fields["url"] as? String).flatMap(DomainMatch.extractHost(fromStoredUrl:)) ?? ""
    return (LoginCandidate(id: id, title: title, username: username, password: password, host: host), vk, top, fileURL)
  }

  /// Appends an "autofill_used" audit event (detail = item title, NEVER the secret value) and
  /// writes the whole vault.json back. Best-effort: failures here must never block the
  /// credential the user already selected, so callers should ignore thrown errors (`try?`).
  ///
  /// This is a SINGLE `NSFileCoordinator` read-modify-write transaction — it re-reads the vault
  /// file itself (rather than being handed a `vaultJSON` snapshot captured earlier by
  /// `loadMatchingLogins`/`loadItem`) so there is no window between an earlier read and this
  /// write in which the main app's own (now-coordinated) save could land and get silently
  /// clobbered by a write of stale content.
  static func appendAutofillAuditEvent(
    itemTitle: String, vaultKey: [UInt8], fileURL: URL
  ) throws {
    var coordinatorError: NSError?
    var thrown: Error?
    let coordinator = NSFileCoordinator(filePresenter: nil)
    coordinator.coordinate(
      readingItemAt: fileURL, options: [],
      writingItemAt: fileURL, options: .forReplacing,
      error: &coordinatorError
    ) { readURL, writeURL in
      do {
        let raw = try Data(contentsOf: readURL)
        guard var top = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
          throw AccessError.malformedVault
        }

        var auditEvents: [[String: Any]] = []
        if let auditValue = top["audit"], !(auditValue is NSNull) {
          // The audit key is present (not merely absent/null) — a decrypt/parse failure here
          // means tampering or corruption, not "no audit log yet". Abort the whole append
          // rather than silently replacing it with a fresh one-event log.
          guard let auditCt = auditValue as? [String: Any],
            let plaintext = decryptCiphertext(ctDict: auditCt, key: vaultKey, ad: "audit:v1"),
            let existing = try? JSONSerialization.jsonObject(with: plaintext) as? [[String: Any]]
          else {
            throw AccessError.auditIntegrityFailure
          }
          auditEvents = existing
        }

        let iso8601 = ISO8601DateFormatter().string(from: Date())
        let newEvent: [String: Any] = ["at": iso8601, "type": "autofill_used", "detail": itemTitle]
        auditEvents.insert(newEvent, at: 0)
        auditEvents = Array(auditEvents.prefix(1000))  // MAX_AUDIT_EVENTS, packages/core/src/model.ts

        let auditPlaintext = try JSONSerialization.data(withJSONObject: auditEvents)
        guard let newAuditCt = encryptForAudit(auditPlaintext, key: vaultKey) else {
          throw AccessError.decryptFailed
        }
        top["audit"] = newAuditCt

        let newRaw = try JSONSerialization.data(withJSONObject: top)
        try newRaw.write(to: writeURL, options: .atomic)
      } catch {
        thrown = error
      }
    }
    if let coordinatorError { throw coordinatorError }
    if let thrown { throw thrown }
  }
}

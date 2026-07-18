import AuthenticationServices
import UIKit

// AutoFill credential provider for the pw-manager vault. Passwords only — no passkeys
// (ASPasskeyCredentialRequest) and no one-time codes, matching V1 scope (see SPEC.md).
//
// Data flow: this extension never derives the KEK from a master password. It reads the Vault
// Key straight out of the shared, Face ID/passcode-gated Keychain item that the main app writes
// in apps/mobile/src/security/biometric.ts (via modules/shared-vault-store) whenever biometrics
// are enabled. If biometrics were never enabled, that Keychain item doesn't exist and every
// method here fails closed — there is no other way into the vault from this extension, by
// design (no master-password entry UI here).
class CredentialProviderViewController: ASCredentialProviderViewController {

  private var listViewController: CredentialListViewController?

  // MARK: - Interactive credential list (user tapped the key icon / "Passwords" picker)

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    // Canonicalize EVERY provided identifier per its `.type` (never trust the raw string, and
    // never look at only `.first`) — see DomainMatch.canonicalHost(from:).
    let requestedHosts = serviceIdentifiers.compactMap(DomainMatch.canonicalHost(from:))

    do {
      let (matches, _, _, _) = try VaultAccess.loadMatchingLogins(
        requestedHosts: requestedHosts, allowUI: true)
      showList(candidates: matches)
    } catch {
      // No shared vault key (biometrics never enabled for this vault), no vault file yet, or
      // the user cancelled/failed the Face ID prompt for the list itself. Show an empty list
      // with a message rather than crash — the user can still use the main app to fill.
      showList(candidates: [])
    }
  }

  private func showList(candidates: [VaultAccess.LoginCandidate]) {
    let vc = CredentialListViewController(
      candidates: candidates,
      onSelect: { [weak self] candidate in
        self?.complete(with: candidate)
      },
      onCancel: { [weak self] in
        self?.extensionContext.cancelRequest(
          withError: NSError(
            domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
      }
    )
    self.listViewController = vc
    addChild(vc)
    view.addSubview(vc.view)
    vc.view.frame = view.bounds
    vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    vc.didMove(toParent: self)
  }

  private func complete(with candidate: VaultAccess.LoginCandidate) {
    let credential = ASPasswordCredential(user: candidate.username, password: candidate.password)
    // Audit logging is best-effort and must never block completing the request with the
    // credential the user already chose.
    if let (_, vk, _, url) = try? VaultAccess.loadItem(byId: candidate.id, allowUI: true) {
      try? VaultAccess.appendAutofillAuditEvent(itemTitle: candidate.title, vaultKey: vk, fileURL: url)
    }
    extensionContext.completeRequest(withSelectedCredential: credential, completionHandler: nil)
  }

  /// Loads `recordId` and verifies the item's CURRENT decrypted host still matches
  /// `credentialIdentity`'s canonicalized service identifier. Guards against a stale QuickType
  /// suggestion handing back a credential for a login whose URL was edited after identity-store
  /// sync (which is async and best-effort) last ran.
  private func loadVerifiedItem(
    recordId: String, credentialIdentity: ASPasswordCredentialIdentity, allowUI: Bool
  ) throws -> (candidate: VaultAccess.LoginCandidate, vaultKey: [UInt8], fileURL: URL) {
    guard let expectedHost = DomainMatch.canonicalHost(from: credentialIdentity.serviceIdentifier)
    else {
      throw VaultAccess.AccessError.malformedVault
    }
    let (candidate, vk, _, url) = try VaultAccess.loadItem(byId: recordId, allowUI: allowUI)
    let match = DomainMatch.compareHosts(requestedHost: expectedHost, storedHost: candidate.host)
    guard match == .exact || match == .subdomain else {
      throw VaultAccess.AccessError.malformedVault
    }
    return (candidate, vk, url)
  }

  // MARK: - QuickType bar (no UI) — must be fast; fall back to interactive on any failure

  override func provideCredentialWithoutUserInteraction(
    for credentialIdentity: ASPasswordCredentialIdentity
  ) {
    guard let recordId = credentialIdentity.recordIdentifier else {
      extensionContext.cancelRequest(
        withError: NSError(
          domain: ASExtensionErrorDomain, code: ASExtensionError.credentialIdentityNotFound.rawValue))
      return
    }
    do {
      // allowUI: false — this callback must never itself trigger a Face ID prompt (Apple's
      // "must not attempt interaction" contract). On any auth-required failure we fall back to
      // prepareInterfaceToProvideCredential below, which correctly uses allowUI: true.
      let (candidate, vk, url) = try loadVerifiedItem(
        recordId: recordId, credentialIdentity: credentialIdentity, allowUI: false)
      let credential = ASPasswordCredential(user: candidate.username, password: candidate.password)
      try? VaultAccess.appendAutofillAuditEvent(itemTitle: candidate.title, vaultKey: vk, fileURL: url)
      extensionContext.completeRequest(withSelectedCredential: credential, completionHandler: nil)
    } catch VaultAccess.AccessError.vaultKeyUnavailable {
      // Face ID/passcode prompt would be required (or biometrics were never enabled for this
      // vault, i.e. no shared Keychain item at all) — let iOS fall back to the interactive flow.
      extensionContext.cancelRequest(
        withError: NSError(
          domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue))
    } catch {
      // Includes: item not found, decrypt failure, and the host-mismatch case from
      // loadVerifiedItem — all treated as "this identity doesn't resolve to a valid credential".
      extensionContext.cancelRequest(
        withError: NSError(
          domain: ASExtensionErrorDomain, code: ASExtensionError.credentialIdentityNotFound.rawValue))
    }
  }

  // MARK: - Interactive fallback for the no-UI path above

  override func prepareInterfaceToProvideCredential(
    for credentialIdentity: ASPasswordCredentialIdentity
  ) {
    let vc = RetryFaceIDViewController(
      onRetry: { [weak self] in
        guard let self, let recordId = credentialIdentity.recordIdentifier else {
          self?.extensionContext.cancelRequest(
            withError: NSError(
              domain: ASExtensionErrorDomain,
              code: ASExtensionError.credentialIdentityNotFound.rawValue))
          return
        }
        do {
          // Interactive callback — allowUI: true is fine here (Apple permits prompting Face ID
          // from this one). Still re-verify the host, in case of a stale QuickType identity.
          let (candidate, vk, url) = try self.loadVerifiedItem(
            recordId: recordId, credentialIdentity: credentialIdentity, allowUI: true)
          let credential = ASPasswordCredential(
            user: candidate.username, password: candidate.password)
          try? VaultAccess.appendAutofillAuditEvent(
            itemTitle: candidate.title, vaultKey: vk, fileURL: url)
          self.extensionContext.completeRequest(
            withSelectedCredential: credential, completionHandler: nil)
        } catch {
          self.extensionContext.cancelRequest(
            withError: NSError(
              domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
        }
      },
      onCancel: { [weak self] in
        self?.extensionContext.cancelRequest(
          withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
      }
    )
    addChild(vc)
    view.addSubview(vc.view)
    vc.view.frame = view.bounds
    vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    vc.didMove(toParent: self)
  }
}

// MARK: - Minimal list UI (title + username, no search/filter beyond the host match already done)

private final class CredentialListViewController: UITableViewController {
  private let candidates: [VaultAccess.LoginCandidate]
  private let onSelect: (VaultAccess.LoginCandidate) -> Void
  private let onCancel: () -> Void

  init(
    candidates: [VaultAccess.LoginCandidate],
    onSelect: @escaping (VaultAccess.LoginCandidate) -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.candidates = candidates
    self.onSelect = onSelect
    self.onCancel = onCancel
    super.init(style: .plain)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Passwords"
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
    tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")

    if candidates.isEmpty {
      let label = UILabel()
      label.text = "No saved logins match this site."
      label.textAlignment = .center
      label.numberOfLines = 0
      label.textColor = .secondaryLabel
      tableView.backgroundView = label
    }
  }

  @objc private func cancelTapped() { onCancel() }

  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    candidates.count
  }

  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath)
    -> UITableViewCell
  {
    let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
    let candidate = candidates[indexPath.row]
    cell.textLabel?.text = candidate.title
    cell.detailTextLabel?.text = candidate.username
    return cell
  }

  override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    onSelect(candidates[indexPath.row])
  }
}

// MARK: - Minimal Face ID retry UI for prepareInterfaceToProvideCredential

private final class RetryFaceIDViewController: UIViewController {
  private let onRetry: () -> Void
  private let onCancel: () -> Void

  init(onRetry: @escaping () -> Void, onCancel: @escaping () -> Void) {
    self.onRetry = onRetry
    self.onCancel = onCancel
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let unlockButton = UIButton(type: .system)
    unlockButton.setTitle("Unlock with Face ID", for: .normal)
    unlockButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

    let cancelButton = UIButton(type: .system)
    cancelButton.setTitle("Cancel", for: .normal)
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [unlockButton, cancelButton])
    stack.axis = .vertical
    stack.spacing = 16
    stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  @objc private func retryTapped() { onRetry() }
  @objc private func cancelTapped() { onCancel() }
}

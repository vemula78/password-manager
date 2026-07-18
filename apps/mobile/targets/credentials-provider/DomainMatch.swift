import Foundation
import AuthenticationServices

// Ported from apps/extension/src/lib/domain.ts's `compareHosts`. Deliberately ASYMMETRIC and
// kept in lockstep with the TS version — do not "simplify" this without updating both.
//
//   - exact: same host (ignoring a leading "www.")
//   - subdomain: the REQUESTED host is a subdomain of the STORED host (an item saved for
//     sbi.co.in also matches netbanking.sbi.co.in)
//   - mismatch: everything else, INCLUDING THE PARENT DIRECTION — an item saved for
//     login.example.com must never silently fill on example.com, and (without a public-suffix
//     list) an item saved for mysite.github.io must never silently fill on github.io.
enum HostMatch {
  case exact
  case subdomain
  case mismatch
}

enum DomainMatch {
  private static func stripWww(_ host: String) -> String {
    host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  /// `requestedHost` = the host iOS is asking AutoFill about (from the credential service
  /// identifier). `storedHost` = the host saved on the vault item.
  ///
  /// Both inputs MUST already be canonicalized hostnames (see `canonicalHost(from:)`) — never
  /// feed a raw, untyped service-identifier string in here directly, or a `.URL`-type
  /// identifier like `https://evil.example/path/.bank.com` will be misread as a subdomain of
  /// `bank.com` by the naive suffix check below when its actual host is `evil.example`.
  static func compareHosts(requestedHost: String, storedHost: String) -> HostMatch {
    let a = stripWww(requestedHost.lowercased())
    let b = stripWww(storedHost.lowercased())
    // IP-literal hosts have no meaningful subdomain relationship — require an exact match only.
    if isIPLiteral(a) || isIPLiteral(b) {
      return a == b ? .exact : .mismatch
    }
    if a == b { return .exact }
    if a.hasSuffix(".\(b)") { return .subdomain }
    return .mismatch
  }

  /// Best-effort host extraction — accepts either a bare host or a full URL string, mirroring
  /// `extractHost` in domain.ts closely enough for the item's stored `url` field.
  static func extractHost(fromStoredUrl raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    guard let host = URL(string: candidate)?.host, !host.isEmpty else { return nil }
    return host.lowercased()
  }

  /// Canonicalizes an `ASCredentialServiceIdentifier` into a bare hostname suitable for
  /// `compareHosts`, honoring `.type` instead of trusting the raw identifier string. Returns
  /// nil if the identifier can't be safely reduced to a host — callers must treat that as
  /// unmatchable, never fall back to guessing from the raw string.
  static func canonicalHost(from identifier: ASCredentialServiceIdentifier) -> String? {
    switch identifier.type {
    case .domain:
      // A `.domain` identifier IS the host. If it contains anything that isn't valid in a bare
      // hostname, something is wrong upstream — refuse rather than risk misreading it.
      let raw = identifier.identifier
      guard !raw.isEmpty,
        !raw.contains("/"), !raw.contains("@"), !raw.contains(":"),
        !raw.contains("?"), !raw.contains("#"), !raw.contains(" ")
      else { return nil }
      return raw.lowercased()
    case .URL:
      // Parse properly and use ONLY the host component — never the raw string, which may embed
      // a decoy host in its path/userinfo (e.g. https://evil.example/path/.bank.com).
      guard let components = URLComponents(string: identifier.identifier),
        let host = components.host, !host.isEmpty
      else { return nil }
      return host.lowercased()
    @unknown default:
      return nil
    }
  }

  private static func isIPLiteral(_ host: String) -> Bool {
    // IPv6 literals contain colons (URLComponents strips the [] brackets from `.host`).
    if host.contains(":") { return true }
    // IPv4 dotted-quad.
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return false }
    return parts.allSatisfy { part in
      guard !part.isEmpty, let n = Int(part), n >= 0, n <= 255 else { return false }
      return String(n) == part
    }
  }
}

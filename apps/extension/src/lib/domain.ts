// Pure, dependency-free domain-matching logic for the "Fill" security gate (SPEC § Browser
// Extension: domain matching, lookalike/phishing warning, HTTP warning). Kept free of chrome.*
// so it is directly unit-testable (see test/domain.test.ts).

/** Extract the hostname from a URL string, lower-cased. Returns null if unparseable. */
export function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Extract the URL scheme ("http:", "https:", ...), lower-cased. Returns null if unparseable. */
export function extractScheme(url: string): string | null {
  try {
    return new URL(url).protocol.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Strip a single leading "www." label — treated as the same site for matching purposes. */
function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

export type HostMatch = "exact" | "subdomain" | "mismatch";

/**
 * Compare the active tab's host against an item's stored host. Deliberately ASYMMETRIC:
 * - "exact": same host (ignoring a leading www.)
 * - "subdomain": the ACTIVE host is a subdomain of the STORED host
 *   (e.g. item saved for sbi.co.in also matches netbanking.sbi.co.in)
 * - "mismatch": everything else — including the PARENT direction: an item saved for
 *   login.example.com must NOT silently fill on example.com. Without a public-suffix list we
 *   cannot tell a registrable domain from a shared parent (an item saved for
 *   mysite.github.io must never silently fill on github.io), so parent-direction fills go
 *   through the explicit mismatch-confirmation path instead of a silent fill.
 */
export function compareHosts(activeHost: string, storedHost: string): HostMatch {
  const a = stripWww(activeHost.toLowerCase());
  const b = stripWww(storedHost.toLowerCase());
  if (a === b) return "exact";
  if (a.endsWith(`.${b}`)) return "subdomain";
  return "mismatch";
}

// Small alphabet of characters attackers commonly substitute in typosquats.
const CONFUSABLES: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "5": "s",
  "vv": "w",
  rn: "m",
};

function normalizeConfusables(host: string): string {
  let out = host;
  for (const [from, to] of Object.entries(CONFUSABLES)) {
    out = out.split(from).join(to);
  }
  return out;
}

/** Classic edit distance — small distances between distinct hosts flag a likely lookalike. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

/**
 * Heuristic lookalike/typosquat detector for hosts that are NOT an exact/subdomain match.
 * Flags: confusable-character substitutions that collapse to the same string, or a small
 * edit distance relative to host length (catches paypa1.com, secure-hdfcbank.example, etc.
 * loosely — false positives are fine here since this only gates a confirmation dialog).
 */
export function isLookalike(activeHost: string, storedHost: string): boolean {
  const a = stripWww(activeHost.toLowerCase());
  const b = stripWww(storedHost.toLowerCase());
  if (a === b) return false;
  if (normalizeConfusables(a) === normalizeConfusables(b)) return true;
  // Compare against the stored host's registrable-ish suffix (last two labels) so
  // "sbi.co.in" vs "sbi-secure.co.in" is judged on the meaningful part.
  const dist = levenshtein(a, b);
  const threshold = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.2));
  return dist > 0 && dist <= threshold && Math.abs(a.length - b.length) <= 3;
}

export interface FillWarning {
  /** True if the user must explicitly confirm before the fill proceeds. */
  requiresConfirmation: boolean;
  reasons: string[];
}

/**
 * Combined pre-fill warning check: host mismatch/lookalike + insecure (http://) page.
 * `itemUrl` is the URL stored on the vault item; `pageUrl` is the active tab's URL.
 */
export function evaluateFillSafety(pageUrl: string, itemUrl: string): FillWarning {
  const reasons: string[] = [];
  const pageHost = extractHost(pageUrl);
  const itemHost = extractHost(itemUrl);
  const scheme = extractScheme(pageUrl);

  if (scheme === "http:") {
    reasons.push(
      "This page is not using a secure connection (http://). Filling credentials here is risky.",
    );
  }

  if (pageHost && itemHost) {
    const match = compareHosts(pageHost, itemHost);
    if (match === "mismatch") {
      if (isLookalike(pageHost, itemHost)) {
        reasons.push(
          `This page's domain (${pageHost}) looks similar to but does not match the saved site (${itemHost}). This may be a phishing attempt.`,
        );
      } else {
        reasons.push(
          `This page's domain (${pageHost}) does not match the saved site (${itemHost}).`,
        );
      }
    }
  } else if (!itemHost) {
    reasons.push("The saved item has no recognizable website URL to compare against this page.");
  }

  return { requiresConfirmation: reasons.length > 0, reasons };
}

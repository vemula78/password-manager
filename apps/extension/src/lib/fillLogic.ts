// DOM fill logic used by the content script (src/content/index.ts). Kept as plain
// document/DOM-API code (no chrome.* calls) so it's unit-testable under jsdom.
// SPEC / acceptance criteria: "do not autofill into hidden fields", "only fill same-origin
// top frame" (enforced by the caller via allFrames:false + this module's own window.top check).

export interface FillPayload {
  username: string | null;
  password: string | null;
}

export interface FillResult {
  filledUsername: boolean;
  filledPassword: boolean;
  reason?: string;
}

/** Minimum rendered size for a field we're willing to fill — anything smaller is treated as
 * a hidden/decoy input (1x1 tracking pixels, clip-path'd honeypots, etc.). */
const MIN_FIELD_PX = 10;
/** How far off-screen (negative offsets) an element may sit before we call it hidden. */
const OFFSCREEN_SLACK_PX = 100;

/**
 * True if the element is actually visible to a sighted user. Rejects, in order:
 * - detached elements and input[type=hidden]
 * - display:none / visibility:hidden / opacity:0 (checked on the element itself)
 * - aria-hidden="true" on the element or any ancestor (fields hidden from AT are decoys)
 * - elements with no layout boxes at all (getClientRects().length === 0 — covers
 *   display:none ancestors too, in environments with a layout engine)
 * - boxes smaller than MIN_FIELD_PX in either dimension (1x1 honeypots)
 * - boxes positioned far outside the document/viewport (text-indent/absolute -9999px tricks)
 *
 * Note on jsdom: jsdom has no layout engine — getClientRects() returns [] and bounding boxes
 * are all zeros for every element. The geometry checks therefore only run when the
 * environment reports at least one client rect; the style/attribute checks run everywhere.
 */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;

  const style = getComputedStyle(el);
  // Compare opacity as a string, not Number(...) — an unset opacity computes to "" in some
  // environments (jsdom) and Number("") === 0 would wrongly mark every element hidden.
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  // aria-hidden on the element or any ancestor: hidden from assistive tech = decoy for us.
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.getAttribute("aria-hidden") === "true") return false;
  }

  // Geometry checks — only meaningful where a layout engine exists (see docstring).
  const rects = el.getClientRects();
  if (rects.length > 0) {
    const box = el.getBoundingClientRect();
    if (box.width < MIN_FIELD_PX || box.height < MIN_FIELD_PX) return false;
    // Far off-screen (classic absolute-position -9999px hiding). Right/bottom edges beyond
    // the document's extents count too.
    const doc = el.ownerDocument;
    const docWidth = Math.max(doc.documentElement.scrollWidth, doc.defaultView?.innerWidth ?? 0);
    const docHeight = Math.max(doc.documentElement.scrollHeight, doc.defaultView?.innerHeight ?? 0);
    const scrollX = doc.defaultView?.scrollX ?? 0;
    const scrollY = doc.defaultView?.scrollY ?? 0;
    const absLeft = box.left + scrollX;
    const absTop = box.top + scrollY;
    if (absLeft + box.width < -OFFSCREEN_SLACK_PX || absTop + box.height < -OFFSCREEN_SLACK_PX) {
      return false;
    }
    if (absLeft > docWidth + OFFSCREEN_SLACK_PX || absTop > docHeight + OFFSCREEN_SLACK_PX) {
      return false;
    }
  } else {
    // Zero client rects = no layout boxes (e.g. a display:none ANCESTOR, which the element's
    // own computed style doesn't reveal in jsdom). Only meaningful in an environment that has
    // a layout engine at all — probe document.body: in a real browser it always has a rect;
    // in jsdom everything (body included) reports zero rects, so the probe skips this check.
    const probe = el.ownerDocument.body?.getClientRects();
    if (probe && probe.length > 0) return false;
  }

  return true;
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const USERNAME_SELECTOR =
  'input[type="text"], input[type="email"], input[type="tel"], input:not([type])';
const PASSWORD_SELECTOR = 'input[type="password"]';

function fillable(el: HTMLInputElement): boolean {
  return !el.disabled && !el.readOnly && isVisible(el);
}

function firstVisible(selector: string, root: ParentNode): HTMLInputElement | null {
  const els = Array.from(root.querySelectorAll<HTMLInputElement>(selector));
  return els.find(fillable) ?? null;
}

/** Username candidate within a scope, preferring an explicit autocomplete="username". */
function findUsernameField(root: ParentNode): HTMLInputElement | null {
  return firstVisible('input[autocomplete="username"]', root) ?? firstVisible(USERNAME_SELECTOR, root);
}

/**
 * Fill username + password into the current document. When the password field lives inside a
 * <form>, the username is looked up within that SAME form — never a first-match elsewhere in
 * the document (prevents a decoy form from soaking up one half of the credentials).
 * Refuses to run in a non-top frame (belt-and-braces alongside the caller's allFrames:false).
 */
export function fillCredentials(payload: FillPayload, doc: Document = document): FillResult {
  if (window.top !== window) {
    return { filledUsername: false, filledPassword: false, reason: "Refused: not the top frame." };
  }

  let filledUsername = false;
  let filledPassword = false;

  const pwField = payload.password ? firstVisible(PASSWORD_SELECTOR, doc) : null;
  // Scope the username lookup to the password field's own form when there is one.
  const usernameScope: ParentNode = pwField?.form ?? doc;

  if (payload.password && pwField) {
    setNativeValue(pwField, payload.password);
    filledPassword = true;
  }
  if (payload.username) {
    const userField =
      findUsernameField(usernameScope) ??
      // Username-only fill (no password requested/found): fall back to the whole document.
      (pwField ? null : findUsernameField(doc));
    if (userField) {
      setNativeValue(userField, payload.username);
      filledUsername = true;
    }
  }

  if (!filledUsername && !filledPassword) {
    return {
      filledUsername,
      filledPassword,
      reason: "No visible username/password field found on this page.",
    };
  }
  return { filledUsername, filledPassword };
}

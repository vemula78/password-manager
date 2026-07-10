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

/**
 * True if the element is actually visible — not display:none / visibility:hidden / opacity:0,
 * the common ways a "honeypot" field is hidden from sighted users while staying in the DOM
 * for naive autofillers to trip over. Deliberately style-based (not offsetParent/geometry —
 * those require a full layout engine that isn't available in every test/runtime environment)
 * so the same check works identically in the browser and under jsdom.
 */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = getComputedStyle(el);
  // Compare opacity as a string, not Number(...) — an unset opacity computes to "" in some
  // environments (jsdom) and Number("") === 0 would wrongly mark every element hidden.
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
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

function firstVisible(selector: string, root: ParentNode): HTMLInputElement | null {
  const els = Array.from(root.querySelectorAll<HTMLInputElement>(selector));
  return els.find((el) => !el.disabled && !el.readOnly && isVisible(el)) ?? null;
}

/**
 * Fill username + password into the first visible matching fields on the current document.
 * Refuses to run in a non-top frame (belt-and-braces alongside the caller's allFrames:false).
 */
export function fillCredentials(payload: FillPayload, doc: Document = document): FillResult {
  if (window.top !== window) {
    return { filledUsername: false, filledPassword: false, reason: "Refused: not the top frame." };
  }

  let filledUsername = false;
  let filledPassword = false;

  if (payload.password) {
    const pwField = firstVisible(PASSWORD_SELECTOR, doc);
    if (pwField) {
      setNativeValue(pwField, payload.password);
      filledPassword = true;
    }
  }
  if (payload.username) {
    const userField =
      firstVisible('input[autocomplete="username"]', doc) ?? firstVisible(USERNAME_SELECTOR, doc);
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

// Pure validation for user-tunable settings values crossing the popup→background message
// boundary. The BACKGROUND enforces these (never trust the UI); the Settings panel mirrors
// them for friendly feedback. Kept chrome-free so the rules are directly unit-testable.

export const AUTO_LOCK_MIN_MINUTES = 1; // "0 = never lock" is deliberately not allowed
export const AUTO_LOCK_MAX_MINUTES = 240;
export const AUTO_LOCK_DEFAULT_MINUTES = 5;

export const CLIPBOARD_CLEAR_MIN_SECONDS = 5;
export const CLIPBOARD_CLEAR_MAX_SECONDS = 300;

export function isValidAutoLockMinutes(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= AUTO_LOCK_MIN_MINUTES && n <= AUTO_LOCK_MAX_MINUTES;
}

export function isValidClipboardClearSeconds(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= CLIPBOARD_CLEAR_MIN_SECONDS &&
    n <= CLIPBOARD_CLEAR_MAX_SECONDS
  );
}

/** Coerce a possibly-invalid stored/imported value (e.g. a vault created by the web app with
 * "0 = never") into the extension's allowed range, falling back to the default. */
export function clampAutoLockMinutes(n: unknown): number {
  return isValidAutoLockMinutes(n) ? n : AUTO_LOCK_DEFAULT_MINUTES;
}

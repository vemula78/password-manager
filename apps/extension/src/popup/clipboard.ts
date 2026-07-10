// Clipboard copy with auto-clear (SPEC acceptance criteria: "Clipboard clears automatically").
// The popup performs the actual write (it has the user gesture navigator.clipboard.writeText
// needs); the background worker schedules an alarm to clear it later via the offscreen
// document (Chrome/Edge) so the clear still happens if the popup has since closed. On
// Firefox (no chrome.offscreen) the value is cleared on next popup open instead — see
// README.md "Clipboard auto-clear" for that documented limitation.
import { call } from "./api";

export async function copyWithAutoClear(value: string, seconds: number): Promise<void> {
  await navigator.clipboard.writeText(value);
  await call({ kind: "SCHEDULE_CLIPBOARD_CLEAR", seconds });
  // Best-effort clear if THIS popup instance is still open when the timer elapses.
  window.setTimeout(() => {
    navigator.clipboard.writeText("").catch(() => {});
  }, seconds * 1000);
}

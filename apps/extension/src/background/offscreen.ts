// Offscreen document (Chrome/Edge only — chrome.offscreen has no Firefox equivalent). Its
// sole job is clipboard access outside of a popup's lifetime: the background worker creates
// this document and messages it when the clipboard-clear alarm fires, so "clear clipboard
// after N seconds" still works even if the user already closed the popup. See README.md
// "Clipboard auto-clear" for the Firefox fallback (clear-on-next-popup-open).
chrome.runtime.onMessage.addListener((msg: { kind?: string }, _sender, sendResponse) => {
  if (msg?.kind !== "OFFSCREEN_CLEAR_CLIPBOARD") return;
  navigator.clipboard
    .writeText("")
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

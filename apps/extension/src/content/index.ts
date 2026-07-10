// Content script — injected ON DEMAND via chrome.scripting.executeScript when the user clicks
// "Fill" in the popup (activeTab permission covers this; there is no persistent
// content_scripts entry in the manifest, and no host_permissions, per the minimal-permissions
// requirement). Only fills the current top-level document (allFrames:false at the injection
// call site, double-checked here too) and only into visible fields (fillLogic.isVisible).
import { fillCredentials, type FillPayload } from "../lib/fillLogic";

declare global {
  interface Window {
    __pwmFillListenerInstalled?: boolean;
  }
}

if (!window.__pwmFillListenerInstalled) {
  window.__pwmFillListenerInstalled = true;
  chrome.runtime.onMessage.addListener(
    (msg: { type?: string } & Partial<FillPayload>, _sender, sendResponse) => {
      if (msg?.type !== "FILL_CREDENTIALS") return;
      const result = fillCredentials({ username: msg.username ?? null, password: msg.password ?? null });
      sendResponse(result);
      return true;
    },
  );
}

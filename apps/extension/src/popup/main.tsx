import { initCrypto } from "@pw/core";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("popup.html is missing #root");

// The popup runs in its own JS context (separate from the background service worker), so it
// needs its own libsodium instance too — the popup uses @pw/core directly for the password
// generator and strength meter (no vault secrets involved; the unlocked vault itself lives
// only in the background worker, see App.tsx / lib/messages.ts).
initCrypto()
  .then(() => createRoot(root).render(<App />))
  .catch((e) => {
    root.textContent = `Failed to initialize: ${e instanceof Error ? e.message : String(e)}`;
  });

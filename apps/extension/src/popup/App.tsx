import { useEffect, useState } from "react";
import type { VaultStatus } from "../lib/messages";
import { call, getActiveTab } from "./api";
import { FirstRun } from "./screens/FirstRun";
import { Locked } from "./screens/Locked";
import { Unlocked } from "./screens/Unlocked";

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);
  const [loadError, setLoadError] = useState("");

  const refresh = async () => {
    try {
      const res = await call<{ ok: true; status: VaultStatus }>({ kind: "STATUS" });
      if (res.ok) setStatus(res.status);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    void getActiveTab().then(setActiveTab);
    void call({ kind: "NOTE_ACTIVITY" });
    // Best-effort: sync whenever the popup opens on an unlocked vault. Silent by design —
    // SYNC_NOW itself decides whether sync is even configured, and any failure just leaves
    // config.lastError set for the Sync panel to show, never a popup-blocking error here.
    void call({ kind: "SYNC_NOW" }).catch(() => {});

    const onMsg = (msg: { kind?: string }) => {
      if (msg?.kind === "LOCKED" || msg?.kind === "UNLOCKED") void refresh();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  if (loadError) {
    return (
      <div className="app">
        <div className="content">
          <p className="error">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="app">
        <div className="content">
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  if (!status.hasVault) {
    return <FirstRun onImported={refresh} />;
  }

  if (!status.unlocked) {
    return <Locked onUnlocked={refresh} onReimport={refresh} />;
  }

  return <Unlocked status={status} activeTab={activeTab} onLocked={refresh} onStatusChanged={refresh} />;
}

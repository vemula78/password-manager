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

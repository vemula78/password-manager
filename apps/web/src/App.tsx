// App shell state machine: loading → no-vault (onboarding) | locked (unlock) → unlocked.
import { initCrypto, type VaultStore } from "@pw/core";
import { useCallback, useEffect, useState } from "react";
import { AppProvider } from "./ctx";
import { loadVaultBlob } from "./lib/storage";
import { Onboarding } from "./screens/Onboarding";
import { Shell } from "./screens/Shell";
import { Unlock } from "./screens/Unlock";

type Phase = "loading" | "no-vault" | "locked" | "unlocked" | "fatal";

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [blob, setBlob] = useState<string | null>(null);
  const [store, setStore] = useState<VaultStore | null>(null);
  const [fatal, setFatal] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initCrypto();
      const b = await loadVaultBlob();
      if (cancelled) return;
      setBlob(b);
      setPhase(b ? "locked" : "no-vault");
    })().catch((err) => {
      if (cancelled) return;
      setFatal(err instanceof Error ? err.message : String(err));
      setPhase("fatal");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnlocked = useCallback((s: VaultStore) => {
    setStore(s);
    setPhase("unlocked");
  }, []);

  const handleLock = useCallback(() => {
    setStore((s) => {
      try {
        s?.lock();
      } catch {
        /* already locked */
      }
      return null;
    });
    setPhase("loading");
    void loadVaultBlob().then((b) => {
      setBlob(b);
      setPhase(b ? "locked" : "no-vault");
    });
  }, []);

  const handleReplaceStore = useCallback((s: VaultStore) => {
    setStore((old) => {
      try {
        if (old && old !== s) old.lock();
      } catch {
        /* noop */
      }
      return s;
    });
  }, []);

  if (phase === "loading") {
    return (
      <div className="center-page">
        <p className="muted">Loading your vault…</p>
      </div>
    );
  }
  if (phase === "fatal") {
    return (
      <div className="center-page">
        <div className="card">
          <h2>Something went wrong</h2>
          <p className="error">{fatal}</p>
          <p className="muted">Try reloading the page. Your encrypted vault is unaffected.</p>
        </div>
      </div>
    );
  }
  if (phase === "no-vault") {
    return <Onboarding onUnlocked={handleUnlocked} />;
  }
  if (phase === "locked" && blob) {
    return <Unlock blob={blob} onUnlocked={handleUnlocked} />;
  }
  if (phase === "unlocked" && store) {
    return (
      <AppProvider store={store} onLock={handleLock} onReplaceStore={handleReplaceStore}>
        <Shell />
      </AppProvider>
    );
  }
  return null;
}

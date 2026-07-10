// Unlocked shell: sidebar navigation + active screen. Checks backup-due on mount
// (non-blocking prompt) and shows an offline indicator.
import { useEffect, useState } from "react";
import { CATEGORIES, type CategoryKey, useApp } from "../ctx";
import { Backup } from "./Backup";
import { Dashboard } from "./Dashboard";
import { Generator } from "./Generator";
import { Health } from "./Health";
import { Items } from "./Items";
import { Settings } from "./Settings";

const FREQ_MS: Record<string, number> = {
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
  monthly: 30 * 24 * 3600_000,
};

export function backupDue(settings: { frequency: string; lastSuccessAt: string | null }): boolean {
  if (settings.frequency === "manual") return false;
  const period = FREQ_MS[settings.frequency];
  if (!period) return false;
  if (!settings.lastSuccessAt) return true;
  return Date.now() - new Date(settings.lastSuccessAt).getTime() > period;
}

export function Shell() {
  const app = useApp();
  const { route, navigate, store } = app;
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Surface vault-file integrity warnings (e.g. recovery data stripped) + backup-due
  // prompt, once per unlock. Non-blocking.
  useEffect(() => {
    for (const w of store.getIntegrityWarnings()) app.toast(w, "error");
    const b = store.settings.backup;
    if (backupDue(b)) {
      app.toast(
        b.lastSuccessAt
          ? "A backup is due — open Backup & restore to run one."
          : "No backup yet — open Backup & restore to protect your vault.",
        "info",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navItem = (label: string, icon: string, active: boolean, onClick: () => void) => (
    <button key={label} className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      {label}
    </button>
  );

  return (
    <div className="app-chrome">
      <aside className="sidebar">
        <div className="brand small">
          <span className="brand-icon">🔐</span>
          <span>Password Vault</span>
        </div>
        {!online && <div className="offline-pill">Offline — everything works except Google Drive</div>}
        <nav>
          {navItem("Dashboard", "🏠", route.name === "dashboard", () => navigate({ name: "dashboard" }))}
          <div className="nav-section">Items</div>
          {(Object.keys(CATEGORIES) as CategoryKey[]).map((key) =>
            navItem(
              CATEGORIES[key].label,
              CATEGORIES[key].icon,
              route.name === "items" && route.category === key,
              () => navigate({ name: "items", category: key }),
            ),
          )}
          <div className="nav-section">Tools</div>
          {navItem("Password generator", "🎲", route.name === "generator", () => navigate({ name: "generator" }))}
          {navItem("Password health", "❤️", route.name === "health", () => navigate({ name: "health" }))}
          {navItem("Backup & restore", "☁️", route.name === "backup", () => navigate({ name: "backup" }))}
          {navItem("Settings", "⚙️", route.name === "settings", () => navigate({ name: "settings" }))}
        </nav>
        <button className="btn lock-btn" onClick={app.lockNow}>
          🔒 Lock now
        </button>
      </aside>
      <main className="content">
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "items" && <Items key={`${route.category}`} />}
        {route.name === "generator" && <Generator />}
        {route.name === "health" && <Health />}
        {route.name === "backup" && <Backup />}
        {route.name === "settings" && <Settings />}
      </main>
    </div>
  );
}

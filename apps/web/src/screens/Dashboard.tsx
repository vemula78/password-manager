// Dashboard: backup status, password health, upcoming reminders (30 days),
// recently used items, quick-add buttons per template.
import { analyzeHealth, TEMPLATES, type ItemType } from "@pw/core";
import { useMemo } from "react";
import { formatDate, formatDateTime } from "../components/ui";
import { useApp } from "../ctx";
import { backupDue } from "./Shell";

const QUICK_ADD: ItemType[] = [
  "login",
  "netbanking",
  "upi",
  "card",
  "demat",
  "govid",
  "note",
  "wifi",
  "insurance",
];

const TYPE_CATEGORY: Record<ItemType, "all" | "banking" | "cards" | "upi" | "govid" | "notes" | "wifi" | "insurance"> = {
  login: "all",
  netbanking: "banking",
  demat: "banking",
  card: "cards",
  upi: "upi",
  govid: "govid",
  note: "notes",
  wifi: "wifi",
  insurance: "insurance",
  custom: "all",
};

export function Dashboard() {
  const app = useApp();
  const { store, rev } = app;
  const items = useMemo(() => store.listItems(), [store, rev]);
  const health = useMemo(() => analyzeHealth(items), [items]);
  const backup = store.settings.backup;

  const upcoming = useMemo(() => {
    const now = Date.now();
    const horizon = now + 30 * 24 * 3600_000;
    const rows: { itemId: string; title: string; label: string; date: string }[] = [];
    for (const item of items) {
      for (const r of item.reminders) {
        const t = new Date(r.date + "T00:00:00").getTime();
        if (!isNaN(t) && t <= horizon && t >= now - 24 * 3600_000) {
          rows.push({ itemId: item.id, title: item.title, label: r.label, date: r.date });
        }
      }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }, [items]);

  const recent = useMemo(
    () =>
      items
        .filter((i) => i.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
        .slice(0, 5),
    [items],
  );

  const due = backupDue(backup);
  const backupState = backup.lastError ? "error" : due ? "due" : backup.lastSuccessAt ? "ok" : "none";

  return (
    <div className="screen">
      <h2>Dashboard</h2>
      <div className="card-grid">
        <button className="card stat-card" onClick={() => app.navigate({ name: "backup" })}>
          <h3>Backup</h3>
          <div className={`stat-big backup-${backupState}`}>
            {backupState === "ok" && "✓ Healthy"}
            {backupState === "due" && "Backup due"}
            {backupState === "error" && "Last backup failed"}
            {backupState === "none" && "No backup yet"}
          </div>
          <p className="muted">
            Last success: {formatDateTime(backup.lastSuccessAt)} · {backup.frequency}
          </p>
          {backup.lastError && <p className="error">{backup.lastError}</p>}
        </button>

        <button className="card stat-card" onClick={() => app.navigate({ name: "health" })}>
          <h3>Password health</h3>
          <div className={`stat-big score-${health.score >= 80 ? "good" : health.score >= 50 ? "mid" : "bad"}`}>
            {health.totalPasswords === 0 ? "—" : `${health.score}/100`}
          </div>
          <p className="muted">
            {health.weakCount} weak · {health.reusedCount} reused · {health.totalPasswords} passwords
          </p>
        </button>

        <div className="card stat-card">
          <h3>Upcoming reminders (30 days)</h3>
          {upcoming.length === 0 && <p className="muted">Nothing due in the next 30 days.</p>}
          <ul className="plain-list">
            {upcoming.slice(0, 6).map((r, i) => (
              <li key={i}>
                <button
                  className="link-btn"
                  onClick={() => app.navigate({ name: "items", category: "all", itemId: r.itemId })}
                >
                  {r.title}
                </button>{" "}
                — {r.label} · <strong>{formatDate(r.date)}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div className="card stat-card">
          <h3>Recently used</h3>
          {recent.length === 0 && <p className="muted">Items you reveal or copy will appear here.</p>}
          <ul className="plain-list">
            {recent.map((i) => (
              <li key={i.id}>
                <button
                  className="link-btn"
                  onClick={() =>
                    app.navigate({ name: "items", category: TYPE_CATEGORY[i.type], itemId: i.id })
                  }
                >
                  {TEMPLATES[i.type].icon} {i.title}
                </button>{" "}
                <span className="muted">{formatDateTime(i.lastUsedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h3 className="section-title">Quick add</h3>
      <div className="quick-add">
        {QUICK_ADD.map((t) => (
          <button
            key={t}
            className="btn quick-btn"
            onClick={() => app.navigate({ name: "items", category: TYPE_CATEGORY[t], addType: t })}
          >
            {TEMPLATES[t].icon} {TEMPLATES[t].label}
          </button>
        ))}
      </div>
    </div>
  );
}

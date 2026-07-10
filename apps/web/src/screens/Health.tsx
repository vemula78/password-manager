// Password health: score, weak passwords, reused groups. Shows item names and field
// labels only — never the password values themselves.
import { analyzeHealth, TEMPLATES } from "@pw/core";
import { useMemo } from "react";
import { useApp } from "../ctx";

export function Health() {
  const app = useApp();
  const { store, rev } = app;
  const report = useMemo(() => analyzeHealth(store.listItems()), [store, rev]);

  const goTo = (itemId: string) => app.navigate({ name: "items", category: "all", itemId });

  return (
    <div className="screen narrow">
      <h2>Password health</h2>

      <div className="card stat-card">
        <div className={`stat-big score-${report.score >= 80 ? "good" : report.score >= 50 ? "mid" : "bad"}`}>
          {report.totalPasswords === 0 ? "No passwords yet" : `${report.score}/100`}
        </div>
        <p className="muted">
          {report.totalPasswords} passwords · {report.weakCount} weak · {report.reusedCount} reused
        </p>
      </div>

      <h3 className="section-title">Weak passwords ({report.weak.length})</h3>
      {report.weak.length === 0 && <p className="muted">None — nice.</p>}
      <div className="card list-card">
        {report.weak.map((u, i) => (
          <button key={i} className="list-row" onClick={() => goTo(u.itemId)}>
            <span>
              {TEMPLATES[store.getItem(u.itemId)?.type ?? "login"].icon} <strong>{u.itemTitle}</strong>{" "}
              — {u.fieldLabel}
            </span>
            <span className={`chip strength-chip ${u.strength}`}>{u.strength.replace("-", " ")} (~{u.bits} bits)</span>
          </button>
        ))}
      </div>

      <h3 className="section-title">Reused passwords ({report.reused.length} groups)</h3>
      {report.reused.length === 0 && <p className="muted">No password is used in more than one place.</p>}
      {report.reused.map((group, gi) => (
        <div className="card list-card" key={gi}>
          <p className="muted pad-h">Same password used in {group.length} places:</p>
          {group.map((u, i) => (
            <button key={i} className="list-row" onClick={() => goTo(u.itemId)}>
              <span>
                <strong>{u.itemTitle}</strong> — {u.fieldLabel}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

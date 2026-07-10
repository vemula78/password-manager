import { useState } from "react";
import { call } from "../api";
import { FirstRun } from "./FirstRun";

export function Locked(props: { onUnlocked: () => void; onReimport: () => void }) {
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [reimporting, setReimporting] = useState(false);

  if (reimporting) return <FirstRun onImported={props.onReimport} />;

  const unlock = async () => {
    if (!pwd) return;
    setBusy(true);
    setErr("");
    const res = await call<{ ok: true } | { ok: false; error: string }>({ kind: "UNLOCK", password: pwd });
    setBusy(false);
    if (res.ok) {
      props.onUnlocked();
    } else {
      setErr(res.error);
      setPwd("");
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="domain">🔒 Vault locked</span>
      </div>
      <div className="content">
        <div className="card">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void unlock();
            }}
          >
            <label className="field">
              <span>Master password</span>
              <input
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                autoFocus
                autoComplete="current-password"
              />
            </label>
            {err && <p className="error">{err}</p>}
            <button type="submit" className="btn primary full" disabled={!pwd || busy}>
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </form>
          <p className="footer-note">
            <button className="link-btn" onClick={() => setReimporting(true)}>
              Import a different backup instead
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

// "Save login for this site" — creates a plain Login item from the active tab's URL/title
// plus a typed or generated credential. Deliberately does NOT scrape the page's actual form
// (V1 is manual save, not full autofill-driven capture — see PLAN.md "Basic browser extension").
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from "@pw/core";
import { useState } from "react";
import { call } from "../api";

export function SaveLoginPanel(props: { activeTab: chrome.tabs.Tab | null; onSaved: () => void }) {
  const [title, setTitle] = useState(props.activeTab?.title ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const url = props.activeTab?.url ?? "";

  const save = async () => {
    if (!title || !password) return;
    setBusy(true);
    setErr("");
    const res = await call<{ ok: true } | { ok: false; error: string }>({
      kind: "SAVE_LOGIN",
      title,
      url,
      username,
      password,
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      props.onSaved();
    } else {
      setErr(res.error);
    }
  };

  return (
    <div className="card">
      <div className="section-title">Save login for this site</div>
      {saved ? (
        <p className="muted">Saved.</p>
      ) : (
        <>
          <label className="field">
            <span>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Username / email</span>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="btn-row">
            <button className="btn" onClick={() => setPassword(generatePassword(DEFAULT_PASSWORD_OPTIONS))}>
              Generate
            </button>
            <button className="btn primary" disabled={!title || !password || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {err && <p className="error">{err}</p>}
          <p className="muted">Site: {url || "(unknown)"}</p>
        </>
      )}
    </div>
  );
}

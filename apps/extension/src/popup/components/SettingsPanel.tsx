import { useState } from "react";
import type { VaultStatus } from "../../lib/messages";
import { call } from "../api";

export function SettingsPanel(props: { status: VaultStatus; onChanged: () => void }) {
  const [autoLock, setAutoLock] = useState(props.status.autoLockMinutes);
  const [clipSeconds, setClipSeconds] = useState(props.status.clipboardClearSeconds);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    await call({ kind: "UPDATE_SETTINGS", autoLockMinutes: autoLock, clipboardClearSeconds: clipSeconds });
    setBusy(false);
    props.onChanged();
  };

  return (
    <div className="card">
      <div className="section-title">Settings</div>
      <label className="field">
        <span>Lock after inactivity (minutes, 0 = never)</span>
        <input
          type="number"
          min={0}
          max={120}
          value={autoLock}
          onChange={(e) => setAutoLock(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>Clear clipboard after (seconds)</span>
        <input
          type="number"
          min={5}
          max={300}
          value={clipSeconds}
          onChange={(e) => setClipSeconds(Number(e.target.value))}
        />
      </label>
      <button className="btn primary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save settings"}
      </button>
      {props.status.integrityWarnings.map((w, i) => (
        <p key={i} className="warning-box">⚠️ {w}</p>
      ))}
    </div>
  );
}

import { useState } from "react";
import {
  AUTO_LOCK_MAX_MINUTES,
  AUTO_LOCK_MIN_MINUTES,
  CLIPBOARD_CLEAR_MAX_SECONDS,
  CLIPBOARD_CLEAR_MIN_SECONDS,
  isValidAutoLockMinutes,
  isValidClipboardClearSeconds,
} from "../../lib/bounds";
import type { VaultStatus } from "../../lib/messages";
import { call } from "../api";

export function SettingsPanel(props: { status: VaultStatus; onChanged: () => void }) {
  const [autoLock, setAutoLock] = useState(props.status.autoLockMinutes);
  const [clipSeconds, setClipSeconds] = useState(props.status.clipboardClearSeconds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Mirrors the BACKGROUND's validation (which is authoritative) for friendly feedback.
  const valid = isValidAutoLockMinutes(autoLock) && isValidClipboardClearSeconds(clipSeconds);

  const save = async () => {
    setBusy(true);
    setErr("");
    const res = await call<{ ok: true } | { ok: false; error: string }>({
      kind: "UPDATE_SETTINGS",
      autoLockMinutes: autoLock,
      clipboardClearSeconds: clipSeconds,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    props.onChanged();
  };

  return (
    <div className="card">
      <div className="section-title">Settings</div>
      <label className="field">
        <span>
          Lock after inactivity (minutes, {AUTO_LOCK_MIN_MINUTES}–{AUTO_LOCK_MAX_MINUTES})
        </span>
        <input
          type="number"
          min={AUTO_LOCK_MIN_MINUTES}
          max={AUTO_LOCK_MAX_MINUTES}
          value={autoLock}
          onChange={(e) => setAutoLock(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>
          Clear clipboard after (seconds, {CLIPBOARD_CLEAR_MIN_SECONDS}–{CLIPBOARD_CLEAR_MAX_SECONDS})
        </span>
        <input
          type="number"
          min={CLIPBOARD_CLEAR_MIN_SECONDS}
          max={CLIPBOARD_CLEAR_MAX_SECONDS}
          value={clipSeconds}
          onChange={(e) => setClipSeconds(Number(e.target.value))}
        />
      </label>
      {!valid && (
        <p className="error">
          Auto-lock must be {AUTO_LOCK_MIN_MINUTES}–{AUTO_LOCK_MAX_MINUTES} minutes and clipboard
          clear {CLIPBOARD_CLEAR_MIN_SECONDS}–{CLIPBOARD_CLEAR_MAX_SECONDS} seconds.
        </p>
      )}
      {err && <p className="error">{err}</p>}
      <button className="btn primary" disabled={busy || !valid} onClick={() => void save()}>
        {busy ? "Saving…" : "Save settings"}
      </button>
      {props.status.integrityWarnings.map((w, i) => (
        <p key={i} className="warning-box">⚠️ {w}</p>
      ))}
    </div>
  );
}

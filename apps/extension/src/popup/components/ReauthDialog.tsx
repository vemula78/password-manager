// Generic master-password reauthentication modal. Used to gate reveal/copy of sensitive
// banking fields (transaction passwords, MPIN, TPIN, CVV, ...) per SPEC's "require explicit
// reveal ... confirmation" rule. The master password never leaves the popup except inside the
// REVEAL_FIELD request itself, which the background worker verifies via @pw/core's
// verifyMasterPassword before returning anything.
import { useState } from "react";

export function ReauthDialog(props: {
  title: string;
  onCancel: () => void;
  onConfirm: (password: string) => Promise<string | null>; // null = wrong password, caller shows error
}) {
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!pwd) return;
    setBusy(true);
    setErr("");
    const result = await props.onConfirm(pwd);
    setBusy(false);
    if (result === null) {
      setErr("Incorrect master password.");
      setPwd("");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="modal">
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
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
          <div className="btn-row">
            <button type="button" className="btn" onClick={props.onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!pwd || busy}>
              {busy ? "Checking…" : "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Password / passphrase generator panel — used by the Generator screen and inline
// from any password field in item forms.
import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  generatePassphrase,
  generatePassword,
  type PassphraseOptions,
  type PasswordOptions,
} from "@pw/core";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../ctx";
import { StrengthMeter } from "./ui";

export function GeneratorPanel(props: { onUse?: (value: string) => void }) {
  const app = useApp();
  const [mode, setMode] = useState<"password" | "passphrase">("password");
  const [pwOpts, setPwOpts] = useState<PasswordOptions>({ ...DEFAULT_PASSWORD_OPTIONS });
  const [ppOpts, setPpOpts] = useState<PassphraseOptions>({ ...DEFAULT_PASSPHRASE_OPTIONS });
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");

  const regen = useCallback(() => {
    setErr("");
    try {
      setValue(mode === "password" ? generatePassword(pwOpts) : generatePassphrase(ppOpts));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setValue("");
    }
  }, [mode, pwOpts, ppOpts]);

  useEffect(() => {
    regen();
  }, [regen]);

  const toggle = (key: keyof Pick<PasswordOptions, "lower" | "upper" | "digits" | "symbols" | "excludeAmbiguous">) =>
    setPwOpts((o) => ({ ...o, [key]: !o[key] }));

  return (
    <div className="gen-panel">
      <div className="seg-row" role="radiogroup" aria-label="Generator mode">
        <label>
          <input type="radio" checked={mode === "password"} onChange={() => setMode("password")} /> Password
        </label>
        <label>
          <input type="radio" checked={mode === "passphrase"} onChange={() => setMode("passphrase")} /> Passphrase
        </label>
      </div>

      <div className="gen-output" data-testid="gen-output">
        <code>{value || "—"}</code>
      </div>
      <StrengthMeter password={value} />
      {err && <p className="error">{err}</p>}

      {mode === "password" ? (
        <div className="gen-opts">
          <label className="field inline">
            <span>Length: {pwOpts.length}</span>
            <input
              type="range"
              min={8}
              max={64}
              value={pwOpts.length}
              onChange={(e) => setPwOpts((o) => ({ ...o, length: Number(e.target.value) }))}
            />
          </label>
          <label className="check"><input type="checkbox" checked={pwOpts.lower} onChange={() => toggle("lower")} /> <span>a–z</span></label>
          <label className="check"><input type="checkbox" checked={pwOpts.upper} onChange={() => toggle("upper")} /> <span>A–Z</span></label>
          <label className="check"><input type="checkbox" checked={pwOpts.digits} onChange={() => toggle("digits")} /> <span>0–9</span></label>
          <label className="check"><input type="checkbox" checked={pwOpts.symbols} onChange={() => toggle("symbols")} /> <span>!@#$</span></label>
          <label className="check">
            <input type="checkbox" checked={pwOpts.excludeAmbiguous} onChange={() => toggle("excludeAmbiguous")} />{" "}
            <span>Avoid look-alikes (0O1lI)</span>
          </label>
        </div>
      ) : (
        <div className="gen-opts">
          <label className="field inline">
            <span>Words: {ppOpts.words}</span>
            <input
              type="range"
              min={3}
              max={10}
              value={ppOpts.words}
              onChange={(e) => setPpOpts((o) => ({ ...o, words: Number(e.target.value) }))}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={ppOpts.capitalize}
              onChange={() => setPpOpts((o) => ({ ...o, capitalize: !o.capitalize }))}
            />{" "}
            <span>Capitalise words</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={ppOpts.includeNumber}
              onChange={() => setPpOpts((o) => ({ ...o, includeNumber: !o.includeNumber }))}
            />{" "}
            <span>Include a number</span>
          </label>
          <label className="field inline">
            <span>Separator</span>
            <input
              type="text"
              className="sep-input"
              maxLength={3}
              value={ppOpts.separator}
              onChange={(e) => setPpOpts((o) => ({ ...o, separator: e.target.value || "-" }))}
            />
          </label>
        </div>
      )}

      <div className="btn-row">
        <button className="btn" onClick={regen}>↻ Regenerate</button>
        <button
          className="btn"
          disabled={!value}
          onClick={() => void app.copyWithClear(value, "Password copied")}
        >
          Copy
        </button>
        {props.onUse && (
          <button className="btn primary" disabled={!value} onClick={() => props.onUse!(value)}>
            Use this
          </button>
        )}
      </div>
    </div>
  );
}

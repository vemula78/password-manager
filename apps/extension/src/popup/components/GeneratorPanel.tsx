import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateStrength,
  generatePassword,
  type PasswordOptions,
} from "@pw/core";
import { useState } from "react";
import { copyWithAutoClear } from "../clipboard";

export function GeneratorPanel(props: { clipboardClearSeconds: number }) {
  const [opts, setOpts] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [value, setValue] = useState(() => generatePassword(DEFAULT_PASSWORD_OPTIONS));

  const regen = (next: PasswordOptions) => {
    setOpts(next);
    setValue(generatePassword(next));
  };

  const { strength, bits } = estimateStrength(value);

  return (
    <div className="card">
      <div className="section-title">Password generator</div>
      <div className="gen-value">{value}</div>
      <p className="muted">{strength} (~{bits} bits)</p>
      <label className="field">
        <span>Length: {opts.length}</span>
        <input
          type="range"
          min={8}
          max={64}
          value={opts.length}
          onChange={(e) => regen({ ...opts, length: Number(e.target.value) })}
        />
      </label>
      {(["lower", "upper", "digits", "symbols"] as const).map((k) => (
        <div className="checkline" key={k}>
          <label>
            <input type="checkbox" checked={opts[k]} onChange={(e) => regen({ ...opts, [k]: e.target.checked })} />{" "}
            {k}
          </label>
        </div>
      ))}
      <div className="btn-row">
        <button className="btn" onClick={() => setValue(generatePassword(opts))}>Regenerate</button>
        <button className="btn primary" onClick={() => void copyWithAutoClear(value, props.clipboardClearSeconds)}>
          Copy
        </button>
      </div>
    </div>
  );
}

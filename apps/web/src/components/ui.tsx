import { estimateStrength, type Strength } from "@pw/core";
import { type ReactNode, useEffect, useRef } from "react";

/* ---------- Modal ---------- */

export function Modal(props: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className={`modal ${props.wide ? "modal-wide" : ""}`} ref={ref} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          {props.onClose && (
            <button className="icon-btn" onClick={props.onClose} aria-label="Close">✕</button>
          )}
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

/* ---------- Password strength meter ---------- */

const STRENGTH_LABEL: Record<Strength, string> = {
  "very-weak": "Very weak",
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
};
const STRENGTH_STEP: Record<Strength, number> = { "very-weak": 1, weak: 2, fair: 3, strong: 4 };

export function StrengthMeter(props: { password: string }) {
  if (!props.password) return null;
  const { strength, bits } = estimateStrength(props.password);
  const step = STRENGTH_STEP[strength];
  return (
    <div className={`strength strength-${strength}`} aria-live="polite">
      <div className="strength-bar">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={i <= step ? "seg on" : "seg"} />
        ))}
      </div>
      <span className="strength-label">
        {STRENGTH_LABEL[strength]} (~{bits} bits)
      </span>
    </div>
  );
}

/* ---------- Small bits ---------- */

export function Warning(props: { children: ReactNode }) {
  return <p className="warning">⚠️ {props.children}</p>;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

import { maskValue, TEMPLATES, type VaultItem } from "@pw/core";
import { useState } from "react";
import { evaluateFillSafety } from "../../lib/domain";
import { fillableFieldsFor } from "../../lib/fillableFields";
import type { ItemSummary } from "../../lib/messages";
import { requiresPerFillConfirmation } from "../../lib/sensitiveFields";
import { call } from "../api";
import { copyWithAutoClear } from "../clipboard";
import { FillConfirmDialog } from "./FillConfirmDialog";
import { ReauthDialog } from "./ReauthDialog";

export function ItemRow(props: {
  summary: ItemSummary;
  activeTab: chrome.tabs.Tab | null;
  clipboardClearSeconds: number;
}) {
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<VaultItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [revealFieldKey, setRevealFieldKey] = useState<string | null>(null);
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [fillConfirm, setFillConfirm] = useState<string[] | null>(null);

  const tpl = TEMPLATES[props.summary.type];

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setErr("");
    const res = await call<{ ok: true; item: VaultItem } | { ok: false; error: string }>({
      kind: "GET_ITEM",
      id: props.summary.id,
    });
    setBusy(false);
    if (res.ok) {
      setItem(res.item);
      setOpen(true);
    } else {
      setErr(res.error);
    }
  };

  const copyField = async (fieldKey: string, sensitive: boolean) => {
    if (!sensitive) {
      await copyWithAutoClear(item?.fields[fieldKey] ?? "", props.clipboardClearSeconds);
      return;
    }
    setRevealFieldKey(fieldKey); // opens the reauth dialog; copy happens on confirm
  };

  const revealField = async (fieldKey: string) => {
    setRevealFieldKey(fieldKey);
  };

  const doFill = async (confirmed: boolean) => {
    if (!props.activeTab?.id || !props.activeTab.url) return;
    setErr("");
    const res = await call<
      | { ok: true; fillWarning: { requiresConfirmation: boolean; reasons: string[] } | null }
      | { ok: true; fillResult: { filledUsername: boolean; filledPassword: boolean; reason?: string } }
      | { ok: false; error: string }
    >({
      kind: "FILL_ACTIVE_TAB",
      id: props.summary.id,
      tabId: props.activeTab.id,
      pageUrl: props.activeTab.url,
      confirmed,
    });
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    if ("fillWarning" in res && res.fillWarning) {
      setFillConfirm(res.fillWarning.reasons);
      return;
    }
    if ("fillResult" in res && res.fillResult.reason && !res.fillResult.filledPassword && !res.fillResult.filledUsername) {
      setErr(res.fillResult.reason);
    }
    setFillConfirm(null);
  };

  const { usernameKey, passwordKey } = fillableFieldsFor(props.summary.type);
  const canFill = !!passwordKey || !!usernameKey;

  const activeHost = props.activeTab?.url ? safeHost(props.activeTab.url) : null;
  const itemUrl = props.summary.url;
  const safety = activeHost && itemUrl ? evaluateFillSafety(props.activeTab!.url!, itemUrl) : null;

  return (
    <div className="item-row">
      <div className="item-title" onClick={() => void toggle()} style={{ cursor: "pointer" }}>
        <span>{tpl?.icon ?? "🔑"}</span>
        <span>{props.summary.title}</span>
      </div>
      <div className="item-sub">
        {props.summary.usernameLike ?? "—"}
        {props.summary.url ? ` · ${props.summary.url}` : ""}
        {requiresPerFillConfirmation(props.summary.type) && " · banking/government item"}
      </div>

      {safety?.requiresConfirmation && (
        <p className="warning-box">⚠️ {safety.reasons[0]}</p>
      )}

      <div className="btn-row">
        {canFill && (
          <button className="btn" onClick={() => void doFill(false)}>
            Fill
          </button>
        )}
        <button className="btn" onClick={() => void toggle()}>
          {open ? "Hide" : busy ? "Loading…" : "Details"}
        </button>
      </div>

      {err && <p className="error">{err}</p>}

      {open && item && (
        <div style={{ marginTop: 8 }}>
          {tpl?.fields.map((f) => {
            const rawValue = item.fields[f.key];
            if (rawValue === undefined) return null;
            const revealed = revealedValues[f.key];
            const display = f.sensitive
              ? revealed ?? (rawValue ? maskValue(rawValue || "••••") : "—")
              : rawValue || "—";
            return (
              <div key={f.key} style={{ marginBottom: 6 }}>
                <div className="muted">{f.label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <code style={{ flex: 1, wordBreak: "break-all" }}>{display}</code>
                  {f.sensitive ? (
                    revealed ? (
                      <button className="link-btn" onClick={() => void copyField(f.key, false)}>
                        copy
                      </button>
                    ) : (
                      <button className="link-btn" onClick={() => void revealField(f.key)}>
                        reveal
                      </button>
                    )
                  ) : (
                    rawValue && (
                      <button className="link-btn" onClick={() => void copyField(f.key, false)}>
                        copy
                      </button>
                    )
                  )}
                </div>
                {f.warning && <div className="muted">{f.warning}</div>}
              </div>
            );
          })}
        </div>
      )}

      {revealFieldKey && (
        <ReauthDialog
          title="Reveal sensitive field"
          onCancel={() => setRevealFieldKey(null)}
          onConfirm={async (password) => {
            const res = await call<{ ok: true; value: string } | { ok: false; error: string }>({
              kind: "REVEAL_FIELD",
              id: props.summary.id,
              fieldKey: revealFieldKey,
              masterPassword: password,
            });
            if (!res.ok) return null;
            setRevealedValues((prev) => ({ ...prev, [revealFieldKey]: res.value }));
            setRevealFieldKey(null);
            return res.value;
          }}
        />
      )}

      {fillConfirm && (
        <FillConfirmDialog
          reasons={fillConfirm}
          onCancel={() => setFillConfirm(null)}
          onConfirm={() => void doFill(true)}
        />
      )}
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

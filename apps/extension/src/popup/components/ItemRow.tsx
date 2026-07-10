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
  /** False on Firefox (no offscreen doc): the clipboard cannot be auto-cleared after the
   * popup closes — sensitive copies must warn first (see clipboardCopyWarning below). */
  canBackgroundClearClipboard: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<VaultItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [revealFieldKey, setRevealFieldKey] = useState<string | null>(null);
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [fillConfirm, setFillConfirm] = useState<string[] | null>(null);
  /** Field key of a pending sensitive copy awaiting the Firefox clipboard warning. */
  const [pendingSensitiveCopy, setPendingSensitiveCopy] = useState<string | null>(null);

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

  /** Copy a NON-sensitive field's stored value. */
  const copyPlainField = async (fieldKey: string) => {
    await copyWithAutoClear(item?.fields[fieldKey] ?? "", props.clipboardClearSeconds);
  };

  /** Copy an already-revealed SENSITIVE value. On browsers without background clipboard
   * clearing (Firefox), interpose a warning first — the clipboard would otherwise hold the
   * secret until the popup is next opened. */
  const copySensitiveValue = async (fieldKey: string) => {
    const value = revealedValues[fieldKey];
    if (value === undefined) return;
    if (!props.canBackgroundClearClipboard && pendingSensitiveCopy !== fieldKey) {
      setPendingSensitiveCopy(fieldKey); // shows the warning + "Copy anyway" button
      return;
    }
    setPendingSensitiveCopy(null);
    await copyWithAutoClear(value, props.clipboardClearSeconds);
  };

  const revealField = async (fieldKey: string) => {
    setRevealFieldKey(fieldKey);
  };

  const doFill = async (confirmed: boolean) => {
    const shownHost = props.activeTab?.url ? safeHost(props.activeTab.url) : null;
    if (!props.activeTab?.id || !shownHost) return;
    setErr("");
    const res = await call<
      | { ok: true; fillWarning: { requiresConfirmation: boolean; reasons: string[] } | null }
      | { ok: true; fillResult: { filledUsername: boolean; filledPassword: boolean; reason?: string } }
      | { ok: false; error: string }
    >({
      kind: "FILL_ACTIVE_TAB",
      id: props.summary.id,
      tabId: props.activeTab.id,
      // The host this popup DISPLAYED (and any confirmation was given for). The background
      // re-reads the tab's live URL itself and aborts if it no longer matches this.
      expectedHost: shownHost,
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
                    revealed !== undefined ? (
                      <button className="link-btn" onClick={() => void copySensitiveValue(f.key)}>
                        copy
                      </button>
                    ) : (
                      <button className="link-btn" onClick={() => void revealField(f.key)}>
                        reveal
                      </button>
                    )
                  ) : (
                    rawValue && (
                      <button className="link-btn" onClick={() => void copyPlainField(f.key)}>
                        copy
                      </button>
                    )
                  )}
                </div>
                {pendingSensitiveCopy === f.key && (
                  <div className="warning-box">
                    ⚠️ On this browser the clipboard cannot be cleared automatically after the
                    popup closes — it will only be cleared the next time you open this popup.
                    Paste the value promptly, then copy something harmless over it.{" "}
                    <button className="link-btn" onClick={() => void copySensitiveValue(f.key)}>
                      Copy anyway
                    </button>{" "}
                    <button className="link-btn" onClick={() => setPendingSensitiveCopy(null)}>
                      Cancel
                    </button>
                  </div>
                )}
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

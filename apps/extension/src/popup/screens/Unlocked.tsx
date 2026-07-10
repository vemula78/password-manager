import { useEffect, useMemo, useState } from "react";
import { extractHost, compareHosts } from "../../lib/domain";
import type { ItemSummary, VaultStatus } from "../../lib/messages";
import { call } from "../api";
import { GeneratorPanel } from "../components/GeneratorPanel";
import { ItemRow } from "../components/ItemRow";
import { SaveLoginPanel } from "../components/SaveLoginPanel";
import { SettingsPanel } from "../components/SettingsPanel";

type Tab = "items" | "save" | "generator" | "settings";

export function Unlocked(props: {
  status: VaultStatus;
  activeTab: chrome.tabs.Tab | null;
  onLocked: () => void;
  onStatusChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("items");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [err, setErr] = useState("");

  const activeHost = props.activeTab?.url ? extractHost(props.activeTab.url) : null;

  const load = async (q: string) => {
    const res = await call<{ ok: true; items: ItemSummary[] } | { ok: false; error: string }>({
      kind: "LIST_ITEMS",
      query: q || undefined,
    });
    if (res.ok) setItems(res.items);
    else setErr(res.error);
  };

  useEffect(() => {
    void load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const sorted = useMemo(() => {
    if (!activeHost) return items;
    const matches: ItemSummary[] = [];
    const rest: ItemSummary[] = [];
    for (const it of items) {
      const h = it.url ? extractHost(it.url) : null;
      if (h && compareHosts(activeHost, h) !== "mismatch") matches.push(it);
      else rest.push(it);
    }
    return [...matches, ...rest];
  }, [items, activeHost]);

  const lockNow = async () => {
    await call({ kind: "LOCK_NOW" });
    props.onLocked();
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="domain">{activeHost ?? "no active site"}</span>
        <button onClick={() => void lockNow()}>Lock now</button>
      </div>
      <div className="content">
        <div className="btn-row" style={{ marginBottom: 8 }}>
          {(["items", "save", "generator", "settings"] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t ? "btn primary" : "btn"}
              onClick={() => setTab(t)}
              style={{ flex: 1 }}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === "items" && (
          <>
            <div className="search-row">
              <input
                type="search"
                placeholder="Search vault…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {err && <p className="error">{err}</p>}
            <div className="item-list">
              {sorted.length === 0 && <p className="muted">No items.</p>}
              {sorted.map((s) => (
                <ItemRow
                  key={s.id}
                  summary={s}
                  activeTab={props.activeTab}
                  clipboardClearSeconds={props.status.clipboardClearSeconds}
                  canBackgroundClearClipboard={props.status.canBackgroundClearClipboard}
                />
              ))}
            </div>
          </>
        )}

        {tab === "save" && <SaveLoginPanel activeTab={props.activeTab} onSaved={() => { void load(query); setTab("items"); }} />}
        {tab === "generator" && <GeneratorPanel clipboardClearSeconds={props.status.clipboardClearSeconds} />}
        {tab === "settings" && <SettingsPanel status={props.status} onChanged={props.onStatusChanged} />}
      </div>
    </div>
  );
}

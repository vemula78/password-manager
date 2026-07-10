// Unlocked-app context: store access, refresh ticks, reauth (60s cache), clipboard copy
// with auto-clear countdown, toasts, kit overlay and simple route state.
import {
  type EmergencyKit,
  type ItemType,
  type Reauth,
  type VaultStore,
  verifyMasterPassword,
} from "@pw/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { KitOverlay } from "./components/Kit";
import { Modal } from "./components/ui";
import { type AppConfig, loadConfig, saveConfig } from "./lib/config";

export type CategoryKey =
  | "all"
  | "banking"
  | "cards"
  | "upi"
  | "govid"
  | "notes"
  | "wifi"
  | "insurance";

export const CATEGORIES: Record<CategoryKey, { label: string; icon: string; types: ItemType[] | null }> = {
  all: { label: "All items", icon: "🗄️", types: null },
  banking: { label: "Banking", icon: "🏦", types: ["netbanking", "demat"] },
  cards: { label: "Cards", icon: "💳", types: ["card"] },
  upi: { label: "UPI", icon: "📲", types: ["upi"] },
  govid: { label: "Government IDs", icon: "🪪", types: ["govid"] },
  notes: { label: "Secure notes", icon: "📝", types: ["note"] },
  wifi: { label: "Wi-Fi", icon: "📶", types: ["wifi"] },
  insurance: { label: "Insurance", icon: "🛡️", types: ["insurance"] },
};

export type Route =
  | { name: "dashboard" }
  | { name: "items"; category: CategoryKey; itemId?: string; addType?: ItemType }
  | { name: "generator" }
  | { name: "health" }
  | { name: "backup" }
  | { name: "settings" };

interface Toast {
  id: number;
  msg: string;
  kind: "info" | "success" | "error";
}

export interface AppCtx {
  store: VaultStore;
  rev: number;
  refresh(): void;
  lockNow(): void;
  /**
   * Ask the user to reconfirm the master password (cached 60s). Resolves with a Reauth
   * proof to pass to core operations, or null if cancelled.
   */
  requestReauth(reason: string, itemId?: string): Promise<Reauth | null>;
  copyWithClear(value: string, label?: string): Promise<void>;
  toast(msg: string, kind?: Toast["kind"]): void;
  config: AppConfig;
  updateConfig(patch: Partial<AppConfig>): void;
  openKit(kit: EmergencyKit): void;
  /** Swap in a different unlocked store (after a restore replaced the local vault). */
  replaceStore(store: VaultStore): void;
  route: Route;
  navigate(route: Route): void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

const REAUTH_CACHE_MS = 60_000;

export function AppProvider(props: {
  store: VaultStore;
  onLock: () => void;
  onReplaceStore: (store: VaultStore) => void;
  children: ReactNode;
}) {
  const { store } = props;
  const [rev, setRev] = useState(0);
  const [route, navigate] = useState<Route>({ name: "dashboard" });
  const [config, setConfigState] = useState<AppConfig>(() => loadConfig());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [kit, setKit] = useState<EmergencyKit | null>(null);
  const [reauthReq, setReauthReq] = useState<{
    reason: string;
    resolve: (reauth: Reauth | null) => void;
  } | null>(null);
  // Cached reauth is scoped to a single item — a reauth granted for one item's sensitive
  // field must not silently unlock another item's, or vault-wide (non-item) actions.
  const reauthCache = useRef<{ reauth: Reauth; at: number; itemId: string } | null>(null);
  const toastId = useRef(0);
  const clipboardTimer = useRef<number | null>(null);

  const refresh = useCallback(() => setRev((r) => r + 1), []);

  const toast = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfigState((prev) => {
      const next = { ...prev, ...patch };
      saveConfig(next);
      return next;
    });
  }, []);

  const lockNow = useCallback(() => {
    reauthCache.current = null;
    if (clipboardTimer.current) {
      window.clearTimeout(clipboardTimer.current);
      clipboardTimer.current = null;
      navigator.clipboard.writeText("").catch(() => {});
    }
    props.onLock();
  }, [props]);

  const requestReauth = useCallback((reason: string, itemId?: string): Promise<Reauth | null> => {
    const cached = reauthCache.current;
    // Only ever reuse a cached reauth for the same item. Non-item actions (settings, kit,
    // etc — itemId undefined) always require a fresh reauth and are never cached.
    if (itemId && cached && cached.itemId === itemId && Date.now() - cached.at < REAUTH_CACHE_MS) {
      return Promise.resolve(cached.reauth);
    }
    reauthCache.current = null;
    return new Promise<Reauth | null>((resolve) => {
      setReauthReq({
        reason,
        resolve: (reauth) => {
          if (reauth && itemId) reauthCache.current = { reauth, at: Date.now(), itemId };
          setReauthReq(null);
          resolve(reauth);
        },
      });
    });
  }, []);

  const copyWithClear = useCallback(
    async (value: string, label = "Copied") => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        toast("Clipboard access was blocked by the browser.", "error");
        return;
      }
      const secs = store.settings.clipboardClearSeconds;
      toast(`${label} — clipboard clears in ${secs}s`, "success");
      if (clipboardTimer.current) window.clearTimeout(clipboardTimer.current);
      clipboardTimer.current = window.setTimeout(() => {
        clipboardTimer.current = null;
        navigator.clipboard
          .writeText("")
          .then(() => toast("Clipboard cleared", "info"))
          .catch(() => {});
      }, secs * 1000);
    },
    [store, toast],
  );

  // Auto-lock: inactivity timer + tab hidden > 1 minute.
  useEffect(() => {
    let idleTimer: number | null = null;
    let hiddenTimer: number | null = null;
    const resetIdle = () => {
      if (idleTimer) window.clearTimeout(idleTimer);
      const mins = Math.max(store.settings.autoLockMinutes, 1);
      idleTimer = window.setTimeout(lockNow, mins * 60_000);
    };
    const onVisibility = () => {
      if (document.hidden) {
        hiddenTimer = window.setTimeout(lockNow, 60_000);
      } else if (hiddenTimer) {
        window.clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, resetIdle, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    resetIdle();
    return () => {
      events.forEach((e) => window.removeEventListener(e, resetIdle));
      document.removeEventListener("visibilitychange", onVisibility);
      if (idleTimer) window.clearTimeout(idleTimer);
      if (hiddenTimer) window.clearTimeout(hiddenTimer);
    };
  }, [store, lockNow, rev]);

  const value = useMemo<AppCtx>(
    () => ({
      store,
      rev,
      refresh,
      lockNow,
      requestReauth,
      copyWithClear,
      toast,
      config,
      updateConfig,
      openKit: setKit,
      replaceStore: props.onReplaceStore,
      route,
      navigate,
    }),
    [store, rev, refresh, lockNow, requestReauth, copyWithClear, toast, config, updateConfig, route, props.onReplaceStore],
  );

  return (
    <Ctx.Provider value={value}>
      {props.children}
      {reauthReq && <ReauthModal store={store} req={reauthReq} />}
      {kit && <KitOverlay kit={kit} onClose={() => setKit(null)} />}
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ReauthModal(props: {
  store: VaultStore;
  req: { reason: string; resolve: (reauth: Reauth | null) => void };
}) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr("");
    // verifyMasterPassword runs Argon2id — yield a frame so the spinner paints.
    await new Promise((r) => setTimeout(r, 30));
    const ok = verifyMasterPassword(props.store.getHeader(), pwd);
    setBusy(false);
    if (ok) {
      props.req.resolve({ masterPassword: pwd });
    } else {
      setErr("Incorrect master password.");
      setPwd("");
    }
  };

  return (
    <Modal title="Confirm it's you" onClose={() => props.req.resolve(null)}>
      <p className="muted">{props.req.reason}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pwd && !busy) void submit();
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
          <button type="button" className="btn" onClick={() => props.req.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!pwd || busy}>
            {busy ? "Checking…" : "Confirm"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

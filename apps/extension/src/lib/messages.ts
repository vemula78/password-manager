// Typed message protocol between popup (thin client) and background (holds the unlocked
// VaultStore in memory — see README.md "Architecture" for why). Every message is a plain,
// JSON-serializable object; chrome.runtime.sendMessage/onMessage carries these directly.
import type { ItemType, VaultItem } from "@pw/core";

export interface VaultStatus {
  hasVault: boolean; // a .pwmbackup has been imported at least once
  unlocked: boolean;
  integrityWarnings: string[];
  autoLockMinutes: number;
  clipboardClearSeconds: number;
  /** False on Firefox (no chrome.offscreen): after the popup closes, the clipboard can only
   * be cleared on the popup's NEXT open — the popup must warn before sensitive copies. */
  canBackgroundClearClipboard: boolean;
}

/** Metadata-safe projection of a VaultItem for list/search UI — sensitive field VALUES are
 * never included here; only which keys exist + whether they're sensitive. */
export interface ItemSummary {
  id: string;
  type: ItemType;
  title: string;
  usernameLike: string | null; // best-effort username/customerId/etc for display
  url: string | null;
  favorite: boolean;
  lastUsedAt: string | null;
}

export type Req =
  | { kind: "STATUS" }
  | { kind: "IMPORT_BACKUP"; backupText: string; credential: { password: string } | { recoveryKey: string } }
  | { kind: "UNLOCK"; password: string }
  | { kind: "LOCK_NOW" }
  | { kind: "LIST_ITEMS"; query?: string }
  | { kind: "GET_ITEM"; id: string }
  /** Reveal/copy a sensitive field. Always requires reauth regardless of caller intent. */
  | { kind: "REVEAL_FIELD"; id: string; fieldKey: string; masterPassword: string }
  | { kind: "TOUCH_USED"; id: string }
  | {
      kind: "SAVE_LOGIN";
      title: string;
      url: string;
      username: string;
      password: string;
    }
  /**
   * expectedHost = the host the popup DISPLAYED to the user (and that any confirmation was
   * given for). The background never fills based on it — it re-fetches the tab's URL at fill
   * time and aborts if the live host no longer equals expectedHost (TOCTOU guard).
   */
  | { kind: "FILL_ACTIVE_TAB"; id: string; tabId: number; expectedHost: string; confirmed: boolean }
  | { kind: "UPDATE_SETTINGS"; autoLockMinutes?: number; clipboardClearSeconds?: number }
  | { kind: "NOTE_ACTIVITY" } // popup pings this so the idle timer resets on real usage
  | { kind: "SCHEDULE_CLIPBOARD_CLEAR"; seconds: number }; // popup wrote to the clipboard itself

export type Res =
  | { ok: true; status: VaultStatus }
  | { ok: true; items: ItemSummary[] }
  | { ok: true; item: VaultItem }
  | { ok: true; value: string }
  | { ok: true; fillWarning: { requiresConfirmation: boolean; reasons: string[] } | null }
  | { ok: true; fillResult: { filledUsername: boolean; filledPassword: boolean; reason?: string } }
  | { ok: true }
  | { ok: false; error: string; requiresReauth?: boolean };

/** Broadcast (no reply expected) sent from background when lock state changes, so any open
 * popup can update immediately instead of polling. */
export type Broadcast = { kind: "LOCKED" } | { kind: "UNLOCKED" };

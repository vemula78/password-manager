// MV3 background service worker — the ONLY place the unlocked VaultStore lives. The popup is
// a thin client that talks to this worker over chrome.runtime messages; nothing decrypted is
// ever written to chrome.storage.local (see README.md "Architecture").
//
// Known limitation (documented, not a bug): MV3 service workers can be killed by the browser
// at any time when idle. When that happens `store` is lost and the worker is unlocked from
// scratch on the next event — this is treated as an automatic lock, same as the idle-timeout
// alarm or "Lock now".
import {
  initCrypto,
  restoreBackup,
  VaultStore,
  verifyMasterPassword,
  WrongCredentialError,
  type ItemType,
  type VaultItem,
} from "@pw/core";
import { blockedForMs, nextBackoffState, resetBackoff } from "../lib/backoff";
import {
  extStorageAdapter,
  loadBackoff,
  loadPrefs,
  loadVaultBlob,
  saveBackoff,
  savePrefs,
} from "../lib/extStorage";
import { fillableFieldsFor } from "../lib/fillableFields";
import { evaluateFillSafety, extractHost } from "../lib/domain";
import {
  clampAutoLockMinutes,
  isValidAutoLockMinutes,
  isValidClipboardClearSeconds,
} from "../lib/bounds";
import { isFillRefusedField, requiresPerFillConfirmation } from "../lib/sensitiveFields";
import type { ItemSummary, Req, Res, VaultStatus } from "../lib/messages";
import { TEMPLATES } from "@pw/core";

const ALARM_AUTO_LOCK = "pwmext-auto-lock";
const ALARM_CLIPBOARD_CLEAR = "pwmext-clipboard-clear";

let store: VaultStore | null = null;
let cryptoReady: Promise<void> | null = null;

async function ensureCrypto(): Promise<void> {
  if (!cryptoReady) cryptoReady = initCrypto();
  await cryptoReady;
}

function broadcast(kind: "LOCKED" | "UNLOCKED"): void {
  chrome.runtime.sendMessage({ kind }).catch(() => {
    // No popup listening — fine, it will query STATUS on next open.
  });
}

async function scheduleAutoLock(): Promise<void> {
  const prefs = await loadPrefs();
  chrome.alarms.clear(ALARM_AUTO_LOCK);
  // clampAutoLockMinutes: an imported vault may carry an out-of-range value (e.g. the web
  // app's "0 = never") — the extension always locks after a bounded idle period.
  chrome.alarms.create(ALARM_AUTO_LOCK, { delayInMinutes: clampAutoLockMinutes(prefs.autoLockMinutes) });
}

function lock(): void {
  if (store) {
    store.lock();
    store = null;
    broadcast("LOCKED");
  }
  chrome.alarms.clear(ALARM_AUTO_LOCK);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_AUTO_LOCK) lock();
  if (alarm.name === ALARM_CLIPBOARD_CLEAR) void clearClipboardViaOffscreen();
});

// Locking on browser/profile close: chrome.storage.local persists across restarts by design
// (that's the point — the encrypted copy survives), but the in-memory store must not. A
// fresh service worker start always begins with store === null, so nothing extra is needed
// here; this listener just makes the "why" explicit and clears any stray alarm.
chrome.runtime.onStartup.addListener(() => {
  store = null;
  chrome.alarms.clear(ALARM_AUTO_LOCK);
});

// ---- offscreen document for clipboard-clear-after-popup-close (Chrome/Edge only) ----------

function hasOffscreenSupport(): boolean {
  return typeof chrome.offscreen !== "undefined";
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!hasOffscreenSupport()) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Clear the clipboard after the configured auto-clear delay.",
    });
  } catch {
    // Already exists — chrome.offscreen.createDocument rejects if one is open; that's fine.
  }
}

async function clearClipboardViaOffscreen(): Promise<void> {
  if (!hasOffscreenSupport()) return; // Firefox: no offscreen API — documented limitation
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ kind: "OFFSCREEN_CLEAR_CLIPBOARD" });
  } catch {
    // Best-effort; if this fails the value is still cleared on next popup open.
  }
}

export async function scheduleClipboardClear(seconds: number): Promise<void> {
  chrome.alarms.clear(ALARM_CLIPBOARD_CLEAR);
  if (seconds > 0) {
    chrome.alarms.create(ALARM_CLIPBOARD_CLEAR, { delayInMinutes: seconds / 60 });
  }
}

// ---- item projection --------------------------------------------------------------------

function toSummary(item: VaultItem): ItemSummary {
  const fields = item.fields;
  const usernameLike =
    fields.username ?? fields.customerId ?? fields.clientId ?? fields.portalUsername ?? null;
  const url = fields.url ?? fields.portalUrl ?? null;
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    usernameLike,
    url,
    favorite: item.favorite,
    lastUsedAt: item.lastUsedAt,
  };
}

/** Strip sensitive field VALUES before an item ever leaves the background worker for the
 * popup — reveal happens only via REVEAL_FIELD after reauth (shell-review-findings.md #1). */
function redactSensitiveFields(item: VaultItem): VaultItem {
  const tpl = TEMPLATES[item.type];
  const sensitiveKeys = new Set(tpl?.fields.filter((f) => f.sensitive).map((f) => f.key) ?? []);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(item.fields)) {
    fields[k] = sensitiveKeys.has(k) ? "" : v;
  }
  return { ...item, fields, customFields: item.customFields.map((c) => (c.sensitive ? { ...c, value: "" } : c)) };
}

// ---- message handling --------------------------------------------------------------------

async function status(): Promise<VaultStatus> {
  const blob = await loadVaultBlob();
  const prefs = await loadPrefs();
  return {
    hasVault: !!blob,
    unlocked: !!store,
    integrityWarnings: store?.getIntegrityWarnings() ?? [],
    autoLockMinutes: clampAutoLockMinutes(store?.settings.autoLockMinutes ?? prefs.autoLockMinutes),
    clipboardClearSeconds: store?.settings.clipboardClearSeconds ?? prefs.clipboardClearSeconds,
    canBackgroundClearClipboard: hasOffscreenSupport(),
  };
}

async function handle(req: Req): Promise<Res> {
  await ensureCrypto();

  switch (req.kind) {
    case "STATUS":
      return { ok: true, status: await status() };

    case "NOTE_ACTIVITY":
      if (store) await scheduleAutoLock();
      return { ok: true };

    case "IMPORT_BACKUP": {
      const backoff = await loadBackoff();
      if (blockedForMs(backoff, Date.now()) > 0) {
        return { ok: false, error: "Too many failed attempts. Please wait before trying again." };
      }
      try {
        const { vaultSerialized } = restoreBackup(req.backupText, req.credential);
        const opened = await VaultStore.open(vaultSerialized, req.credential, extStorageAdapter);
        await opened.logAndPersist("restore_completed");
        store = opened;
        await saveBackoff(resetBackoff());
        await savePrefs({
          autoLockMinutes: store.settings.autoLockMinutes,
          clipboardClearSeconds: store.settings.clipboardClearSeconds,
        });
        await scheduleAutoLock();
        broadcast("UNLOCKED");
        return { ok: true, status: await status() };
      } catch (e) {
        if (e instanceof WrongCredentialError) await saveBackoff(nextBackoffState(backoff, Date.now()));
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "UNLOCK": {
      const backoff = await loadBackoff();
      if (blockedForMs(backoff, Date.now()) > 0) {
        return { ok: false, error: "Too many failed attempts. Please wait before trying again." };
      }
      const blob = await loadVaultBlob();
      if (!blob) return { ok: false, error: "No vault has been imported yet." };
      try {
        const opened = await VaultStore.open(blob, { password: req.password }, extStorageAdapter);
        store = opened;
        await saveBackoff(resetBackoff());
        await savePrefs({
          autoLockMinutes: store.settings.autoLockMinutes,
          clipboardClearSeconds: store.settings.clipboardClearSeconds,
        });
        await scheduleAutoLock();
        broadcast("UNLOCKED");
        return { ok: true, status: await status() };
      } catch (e) {
        if (e instanceof WrongCredentialError) await saveBackoff(nextBackoffState(backoff, Date.now()));
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "LOCK_NOW":
      lock();
      return { ok: true };

    case "LIST_ITEMS": {
      if (!store) return { ok: false, error: "Vault is locked." };
      await scheduleAutoLock();
      const items = req.query ? store.search(req.query) : store.listItems();
      return { ok: true, items: items.map(toSummary) };
    }

    case "GET_ITEM": {
      if (!store) return { ok: false, error: "Vault is locked." };
      await scheduleAutoLock();
      const item = store.getItem(req.id);
      if (!item) return { ok: false, error: "Item not found." };
      return { ok: true, item: redactSensitiveFields(item) };
    }

    case "REVEAL_FIELD": {
      if (!store) return { ok: false, error: "Vault is locked." };
      if (!verifyMasterPassword(store.getHeader(), req.masterPassword)) {
        return { ok: false, error: "Incorrect master password.", requiresReauth: true };
      }
      const item = store.getItem(req.id);
      if (!item) return { ok: false, error: "Item not found." };
      const value = item.fields[req.fieldKey] ?? "";
      await store.logAndPersist("sensitive_revealed", `${item.title} — ${req.fieldKey}`);
      await scheduleAutoLock();
      return { ok: true, value };
    }

    case "TOUCH_USED": {
      if (!store) return { ok: false, error: "Vault is locked." };
      await store.touchUsed(req.id);
      return { ok: true };
    }

    case "SAVE_LOGIN": {
      if (!store) return { ok: false, error: "Vault is locked." };
      await store.addItem({
        type: "login",
        title: req.title,
        fields: { username: req.username, password: req.password, url: req.url },
      });
      await scheduleAutoLock();
      return { ok: true };
    }

    case "FILL_ACTIVE_TAB": {
      if (!store) return { ok: false, error: "Vault is locked." };
      const item = store.getItem(req.id);
      if (!item) return { ok: false, error: "Item not found." };

      const { usernameKey, passwordKey } = fillableFieldsFor(item.type as ItemType);
      if (passwordKey && isFillRefusedField(item.type, passwordKey)) {
        // Should never happen given fillableFieldsFor's fixed map, but double-checked per
        // shell-review-findings.md discipline: never trust a single layer for this rule.
        return { ok: false, error: "This field cannot be auto-filled. Use copy or reveal instead." };
      }

      // TOCTOU guard: never trust the popup's snapshot of the tab or its URL — the tab can
      // navigate (or be swapped) between popup-open and the Fill click, and between a warning
      // and its "Fill anyway" confirmation. Fetch the tab NOW, require it to still be the
      // active tab of the current window, and evaluate every safety rule against its URL at
      // this instant. This block re-runs in full on the post-confirmation call too.
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || activeTab.id !== req.tabId) {
        return { ok: false, error: "The target tab is no longer the active tab. Fill cancelled." };
      }
      const pageUrl = activeTab.url ?? "";
      const pageHost = extractHost(pageUrl);
      if (!pageHost) {
        return { ok: false, error: "Cannot determine this page's address. Fill cancelled." };
      }
      if (pageHost !== req.expectedHost.trim().toLowerCase()) {
        return {
          ok: false,
          error: `This page changed to ${pageHost} after the popup opened. Fill cancelled — close and reopen the popup to continue.`,
        };
      }

      const bankingConfirmNeeded = requiresPerFillConfirmation(item.type) && !req.confirmed;
      const safety = evaluateFillSafety(pageUrl, item.fields.url ?? item.fields.portalUrl ?? "");
      const needsConfirm = bankingConfirmNeeded || (safety.requiresConfirmation && !req.confirmed);
      if (needsConfirm) {
        const reasons = [...safety.reasons];
        if (bankingConfirmNeeded) {
          reasons.unshift(
            `"${item.title}" is a banking/government item. Confirm you want to fill credentials on ${pageHost}.`,
          );
        }
        return { ok: true, fillWarning: { requiresConfirmation: true, reasons } };
      }

      const username = usernameKey ? item.fields[usernameKey] ?? null : null;
      const password = passwordKey ? item.fields[passwordKey] ?? null : null;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: req.tabId, allFrames: false },
          files: ["content.js"],
        });
        const result = await chrome.tabs.sendMessage(req.tabId, {
          type: "FILL_CREDENTIALS",
          username,
          password,
        });
        await store.touchUsed(item.id);
        await store.logAndPersist("item_viewed", `${item.title} — filled`);
        return { ok: true, fillResult: result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "SCHEDULE_CLIPBOARD_CLEAR":
      await scheduleClipboardClear(req.seconds);
      return { ok: true };

    case "UPDATE_SETTINGS": {
      if (!store) return { ok: false, error: "Vault is locked." };
      // Bounds enforced HERE, not just in the Settings UI. No "0 = never": the extension
      // always auto-locks within a bounded idle period (1–240 minutes).
      if (req.autoLockMinutes !== undefined && !isValidAutoLockMinutes(req.autoLockMinutes)) {
        return { ok: false, error: "Auto-lock must be a whole number of minutes between 1 and 240." };
      }
      if (
        req.clipboardClearSeconds !== undefined &&
        !isValidClipboardClearSeconds(req.clipboardClearSeconds)
      ) {
        return { ok: false, error: "Clipboard clear must be a whole number of seconds between 5 and 300." };
      }
      await store.updateSettings({
        ...(req.autoLockMinutes !== undefined ? { autoLockMinutes: req.autoLockMinutes } : {}),
        ...(req.clipboardClearSeconds !== undefined
          ? { clipboardClearSeconds: req.clipboardClearSeconds }
          : {}),
      });
      await savePrefs({
        autoLockMinutes: store.settings.autoLockMinutes,
        clipboardClearSeconds: store.settings.clipboardClearSeconds,
      });
      await scheduleAutoLock();
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown request." };
  }
}

/** Requests that touch vault contents or drive a fill — only the extension's own popup may
 * send these. Everything else (STATUS/NOTE_ACTIVITY/LOCK_NOW/SCHEDULE_CLIPBOARD_CLEAR) is
 * still restricted to this extension's own pages, just not popup-specifically. */
const POPUP_ONLY_KINDS: ReadonlySet<Req["kind"]> = new Set([
  "UNLOCK",
  "IMPORT_BACKUP",
  "LIST_ITEMS",
  "GET_ITEM",
  "REVEAL_FIELD",
  "TOUCH_USED",
  "SAVE_LOGIN",
  "UPDATE_SETTINGS",
  "FILL_ACTIVE_TAB",
]);

/**
 * Sender gate. Messages must originate from THIS extension (sender.id), and from one of its
 * own extension pages (sender.url under chrome.runtime.getURL("")) — content scripts run in
 * web pages, so their sender.url is the page URL and they are rejected outright: there are
 * deliberately no content-script-initiated messages in this design (the content script only
 * ever REPLIES to a tabs.sendMessage from the background). Privileged kinds additionally
 * require the popup page itself.
 */
function senderAllowed(req: Req, sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? "";
  if (!url.startsWith(chrome.runtime.getURL(""))) return false; // rejects all web-page senders
  if (POPUP_ONLY_KINDS.has(req.kind)) {
    return url.startsWith(chrome.runtime.getURL("popup.html"));
  }
  return true;
}

chrome.runtime.onMessage.addListener((req: Req, sender, sendResponse) => {
  if (!req || typeof req.kind !== "string") return; // not ours (e.g. offscreen protocol)
  if (!senderAllowed(req, sender)) {
    sendResponse({ ok: false, error: "Request rejected: unauthorized sender." });
    return;
  }
  handle(req)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // keep the message channel open for the async response
});

void ensureCrypto();

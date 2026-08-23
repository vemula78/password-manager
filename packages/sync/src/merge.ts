// Conflict-resolution merge engine for V2 multi-device sync (SYNC-DESIGN.md § 5).
//
// Pure and synchronous: no I/O, no crypto, no network, no system clock. It operates on
// DECRYPTED items — decryption/encryption stays in packages/core — so the whole conflict
// matrix is unit-testable without a server or a database.
//
// The load-bearing rule: when two devices edited the same item, the loser of the
// last-writer-wins call is NEVER discarded. It is preserved as a new item. A wrong LWW call
// (clock skew across devices is real and is not corrected here) costs a spurious duplicate,
// not a credential.
import { randomId, TOMBSTONE_RETENTION_DAYS } from "@pw/core";
import type { Tombstone, VaultItem } from "@pw/core";

/**
 * id → the item's `updatedAt` as of the last successful sync with this server. Minimal by
 * design: the merge only ever asks "did THIS side change since the last sync?", and storing a
 * full plaintext snapshot outside the vault is not acceptable. Compute it with nextSyncBase().
 */
export type SyncBase = Record<string, string>;

export interface MergeInput {
  local: VaultItem[];
  localDeletions: Tombstone[];
  remote: VaultItem[];
  remoteDeletions: Tombstone[];
  /**
   * State at the last successful sync. Optional but strongly recommended: it is what
   * distinguishes "I changed it" from "they never changed it". Without a base, an edit here
   * against an untouched stale copy there is indistinguishable from two real edits, and is
   * resolved as a conflict — safe, but it produces a spurious conflicted copy on every first
   * sync after any edit. Also used to decide whether a local-only item is an addition the
   * server has never seen.
   */
  base?: SyncBase;
  deviceLabel: string;
  /** ISO timestamp; injected so the engine has no clock of its own. */
  now: string;
  /** Injectable so conflict-copy ids are pinnable in tests. Defaults to @pw/core randomId. */
  newId?: () => string;
}

export interface MergeConflict {
  /** The surviving (winning) item. */
  id: string;
  /** The preserved loser. */
  conflictCopyId: string;
  /** Title of the winning item, for the UI's conflict banner. */
  title: string;
}

export interface MergeResult {
  items: VaultItem[];
  deletions: Tombstone[];
  /** ids whose ciphertext must be re-encrypted / pushed. */
  changedIds: string[];
  conflicts: MergeConflict[];
}

export const CONFLICT_TAG = "conflict";

const MS_PER_DAY = 86_400_000;

/** Structural equality over decrypted items. Key order is irrelevant; array order is not. */
export function itemsEqual(a: VaultItem, b: VaultItem): boolean {
  return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  // An unparseable timestamp must not silently become "epoch" and win/lose every comparison.
  if (Number.isNaN(t)) throw new Error(`mergeVaults: unparseable timestamp ${JSON.stringify(iso)}`);
  return t;
}

/** DD-MMM-YYYY, for the human-readable conflict-copy title suffix. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function displayDate(iso: string): string {
  const d = new Date(ms(iso));
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${dd}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export function conflictCopyTitle(title: string, deviceLabel: string, now: string): string {
  return `${title} (conflicted copy — ${deviceLabel}, ${displayDate(now)})`;
}

/**
 * The base to store after committing a merge result: the caller must derive it from the very
 * items it persisted, so the two cannot drift apart.
 */
export function nextSyncBase(items: VaultItem[]): SyncBase {
  const b: SyncBase = {};
  for (const i of items) b[i.id] = i.updatedAt;
  return b;
}

function byId<T extends { id: string }>(xs: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of xs) m.set(x.id, x);
  return m;
}

function makeConflictCopy(
  loser: VaultItem,
  id: string,
  deviceLabel: string,
  now: string,
): VaultItem {
  return {
    ...loser,
    id,
    title: conflictCopyTitle(loser.title, deviceLabel, now),
    tags: loser.tags.includes(CONFLICT_TAG) ? [...loser.tags] : [...loser.tags, CONFLICT_TAG],
    // Field values, notes, custom fields, password history and versions are carried over
    // untouched: this copy is the only remaining record of the losing edit.
    updatedAt: now,
  };
}

/**
 * Merge a local vault with a pulled remote vault. Per item, never per vault.
 *
 * Resolution order for one id:
 *  1. tombstone (union of both sides, earliest deletedAt wins, expired ones GC'd) vs the
 *     newest surviving edit: delete wins iff deletedAt > updatedAt, else the edit resurrects
 *     the item and the tombstone is dropped;
 *  2. identical contents on both sides → take either, nothing changed;
 *  3. otherwise last-writer-wins by updatedAt, and the loser is preserved as a new item.
 */
export function mergeVaults(input: MergeInput): MergeResult {
  const { deviceLabel, now } = input;
  const newId = input.newId ?? randomId;
  const cutoff = ms(now) - TOMBSTONE_RETENTION_DAYS * MS_PER_DAY;

  const local = byId(input.local);
  const remote = byId(input.remote);
  const base = input.base;

  // Tombstones: union; if both sides have one for the same id keep the EARLIER deletedAt
  // (the original deletion event); garbage-collect anything past the retention window.
  const tombstones = new Map<string, Tombstone>();
  for (const t of [...input.localDeletions, ...input.remoteDeletions]) {
    if (ms(t.deletedAt) < cutoff) continue; // expired → GC
    const existing = tombstones.get(t.id);
    if (!existing || ms(t.deletedAt) < ms(existing.deletedAt)) tombstones.set(t.id, t);
  }

  const items: VaultItem[] = [];
  const changed = new Set<string>();
  const conflicts: MergeConflict[] = [];

  const ids = [...new Set([...local.keys(), ...remote.keys()])].sort();
  for (const id of ids) {
    const l = local.get(id);
    const r = remote.get(id);
    const tomb = tombstones.get(id);

    let survivor: VaultItem;
    let loser: VaultItem | undefined;

    if (l && r) {
      const b = base?.[id];
      const localTouched = b === undefined || l.updatedAt !== b;
      const remoteTouched = b === undefined || r.updatedAt !== b;
      if (deepEqual(l, r)) {
        survivor = l;
      } else if (!localTouched && remoteTouched) {
        // Only the other device changed it since the last sync.
        survivor = r;
      } else if (!remoteTouched && localTouched) {
        // Only this device changed it — the other side is just the last-synced copy.
        survivor = l;
      } else if (ms(r.updatedAt) > ms(l.updatedAt)) {
        survivor = r;
        loser = l;
      } else {
        // Ties resolve to the local copy; the remote is still preserved below.
        survivor = l;
        loser = r;
      }
    } else {
      survivor = (l ?? r)!;
    }

    if (tomb && ms(tomb.deletedAt) > ms(survivor.updatedAt)) {
      // Deletion beats edit. The item (and any losing edit older still) stays deleted.
      if (l) changed.add(id); // the local copy must go away
      continue;
    }
    // Either no tombstone, or a deliberate edit after the delete → resurrect, drop tombstone.
    if (tomb) tombstones.delete(id);

    items.push(survivor);

    if (loser) {
      const copyId = newId();
      const copy = makeConflictCopy(loser, copyId, deviceLabel, now);
      items.push(copy);
      changed.add(copyId);
      // Both sides need the outcome: the winner's ciphertext is re-pushed too, since the
      // other device holds a different plaintext for this id.
      changed.add(id);
      conflicts.push({ id, conflictCopyId: copy.id, title: survivor.title });
    } else if (!l) {
      changed.add(id); // genuine remote addition (or resurrection) — store it locally
    } else if (r && survivor !== l) {
      changed.add(id); // the other device's edit lands here
    } else if (r && !deepEqual(l, r)) {
      changed.add(id); // our edit must go back to a side that still holds the old copy
    } else if (tomb) {
      changed.add(id); // resurrected a locally-tombstoned item — push it back
    } else if (!r) {
      // Local-only item: a local addition the server has not seen must be pushed. Without a
      // base we cannot tell, and we do not guess — the caller's rev bookkeeping covers it.
      const b = base?.[id];
      if (base && b !== survivor.updatedAt) changed.add(id);
    }
  }

  // Tombstones for ids we no longer hold anywhere still matter: another device may hold the
  // item. Keep every surviving (non-expired, non-resurrected) tombstone.
  const deletions = [...tombstones.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    items,
    deletions,
    changedIds: [...changed].sort(),
    conflicts,
  };
}

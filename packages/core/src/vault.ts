// VaultStore: the unlocked, in-memory vault. On disk it is a single JSON document —
// plaintext header (KDF params + key envelopes only) plus per-item ciphertexts and an
// encrypted audit log. Every mutation re-serializes and hands the blob to the storage
// adapter; nothing sensitive ever touches storage unencrypted.
import {
  Ciphertext,
  decryptJson,
  encryptJson,
  randomId,
  wipe,
} from "./crypto";
import {
  UnlockedKeys,
  VaultHeader,
  createVaultHeader,
  rewrapWithNewPassword,
  setupRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  verifyMasterPassword,
} from "./keys";
import {
  AuditEvent,
  AuditEventType,
  DEFAULT_SETTINGS,
  MAX_AUDIT_EVENTS,
  MAX_PASSWORD_HISTORY,
  MAX_VERSIONS_PER_ITEM,
  TOMBSTONE_RETENTION_DAYS,
  Tombstone,
  VaultItem,
  VaultSettings,
} from "./model";
import { TEMPLATES } from "./templates";

export interface VaultFile {
  format: "pwm-vault";
  /**
   * Vault FILE version. Absent means v1 (pre-sync). v2 adds deletion tombstones. The KEY
   * hierarchy is unchanged, so `header.version` stays 1 — only the envelope around it grew.
   * v1 files migrate transparently on open (empty tombstone list).
   */
  fileVersion?: 2;
  header: VaultHeader;
  items: { id: string; ct: Ciphertext }[];
  /**
   * V2 sync: hard deletes leave a tombstone so other devices cannot resurrect the item.
   *
   * SEALED — the deletion time and originating device are encrypted under the Vault Key,
   * with the item id bound in as associated data. Only the id stays in the clear, because
   * the server needs it to key the row (and already sees it on the item itself).
   *
   * This is what stops a malicious server from FORGING deletions: an attacker who cannot
   * produce a valid AEAD tag cannot fabricate a tombstone, so it cannot make a client
   * silently destroy a credential. It also keeps deletion history off the server, per
   * SPEC.md's "the server only stores encrypted data".
   */
  deletions?: SealedTombstone[];
  audit: Ciphertext | null;
  settings: Ciphertext | null;
}

export const VAULT_FILE_VERSION = 2 as const;

/** A tombstone as it is stored and transmitted: id in the clear, the rest authenticated. */
export interface SealedTombstone {
  id: string;
  ct: Ciphertext;
}

export function sealTombstone(t: Tombstone, vk: Uint8Array): SealedTombstone {
  return {
    id: t.id,
    ct: encryptJson({ deletedAt: t.deletedAt, deviceId: t.deviceId }, vk, adTombstone(t.id)),
  };
}

/** Throws if the tombstone was forged, altered, or moved to a different item id. */
export function openTombstone(sealed: SealedTombstone, vk: Uint8Array): Tombstone {
  const inner = decryptJson<{ deletedAt: string; deviceId: string }>(
    sealed.ct,
    vk,
    adTombstone(sealed.id),
  );
  if (typeof inner.deletedAt !== "string" || Number.isNaN(Date.parse(inner.deletedAt))) {
    throw new Error("Tombstone has an invalid deletion time.");
  }
  return { id: sealed.id, deletedAt: inner.deletedAt, deviceId: inner.deviceId };
}

export interface VaultStoreOptions {
  /**
   * Stable per-device identifier, used to attribute tombstones and conflict copies. It is
   * LOCAL to the device and deliberately not part of synced settings. Shells generate one
   * once and keep it in ordinary (non-sensitive) local storage.
   */
  deviceId?: string;
  now?: () => string;
}

export interface StorageAdapter {
  save(serialized: string): Promise<void>;
}

const adItem = (id: string) => `item:${id}`;
// Binds a sealed tombstone to the item id it deletes, so a server cannot move a legitimate
// tombstone onto a different item, nor invent one for an id it has merely observed.
const adTombstone = (id: string) => `tombstone:${id}`;
const AD_AUDIT = "audit:v1";
const AD_SETTINGS = "settings:v1";

export type NewItemInput = Pick<VaultItem, "type" | "title"> &
  Partial<Omit<VaultItem, "id" | "createdAt" | "updatedAt" | "versions" | "passwordHistory">>;

/**
 * Proof of fresh reauthentication for security-sensitive operations (spec: "Recovery
 * changes must require reauthentication"). The master password is verified by core.
 * A vault opened with the recovery key counts as reauthenticated for the recovery flow
 * itself (that unlock IS the stronger credential).
 */
export type Reauth = { masterPassword: string };

export class ReauthRequiredError extends Error {
  constructor() {
    super("Reauthentication with the master password is required for this action.");
    this.name = "ReauthRequiredError";
  }
}

export class VaultStore {
  private header: VaultHeader;
  private keys: UnlockedKeys;
  private items: Map<string, VaultItem>;
  private audit: AuditEvent[];
  settings: VaultSettings;
  private storage: StorageAdapter;
  private now: () => string;
  private unlockedVia: "password" | "recovery";
  private integrityWarnings: string[] = [];
  private deletions: Map<string, Tombstone>;
  private deviceId: string;
  /**
   * Cached ciphertext per item. Without this, serialize() re-encrypts EVERY item (fresh
   * nonce) on EVERY mutation, so all ciphertexts change when one item is edited — which
   * makes per-item sync impossible and costs an O(n) encrypt on each save. Entries are
   * invalidated by markDirty() whenever the item actually changes.
   */
  private ctCache: Map<string, Ciphertext>;

  private constructor(
    header: VaultHeader,
    keys: UnlockedKeys,
    items: VaultItem[],
    audit: AuditEvent[],
    settings: VaultSettings,
    storage: StorageAdapter,
    now: () => string,
    unlockedVia: "password" | "recovery",
    deviceId: string,
    deletions: Tombstone[],
    ctCache: Map<string, Ciphertext>,
  ) {
    this.header = header;
    this.keys = keys;
    this.items = new Map(items.map((i) => [i.id, structuredClone(i)]));
    this.audit = audit;
    this.settings = settings;
    this.storage = storage;
    this.now = now;
    this.unlockedVia = unlockedVia;
    this.deviceId = deviceId;
    this.deletions = new Map(deletions.map((d) => [d.id, d]));
    this.ctCache = ctCache;
  }

  /** Drop the cached ciphertext for an item so serialize() re-encrypts it with a fresh nonce. */
  private markDirty(id: string): void {
    this.ctCache.delete(id);
  }

  static async create(
    masterPassword: string,
    storage: StorageAdapter,
    nowOrOpts: (() => string) | VaultStoreOptions = () => new Date().toISOString(),
  ): Promise<VaultStore> {
    const { now, deviceId } = normalizeOptions(nowOrOpts);
    const { header, keys } = createVaultHeader(masterPassword, now());
    const store = new VaultStore(
      header, keys, [], [], structuredClone(DEFAULT_SETTINGS), storage, now, "password",
      deviceId, [], new Map(),
    );
    store.log("vault_created");
    await store.persist();
    return store;
  }

  static async open(
    serialized: string,
    credential: { password: string } | { recoveryKey: string },
    storage: StorageAdapter,
    nowOrOpts: (() => string) | VaultStoreOptions = () => new Date().toISOString(),
  ): Promise<VaultStore> {
    const { now, deviceId } = normalizeOptions(nowOrOpts);
    const file = parseVaultFile(serialized);
    const keys =
      "password" in credential
        ? unlockWithPassword(file.header, credential.password)
        : unlockWithRecoveryKey(file.header, credential.recoveryKey);
    const items = file.items.map((e) => decryptJson<VaultItem>(e.ct, keys.vk, adItem(e.id)));
    const audit = file.audit ? decryptJson<AuditEvent[]>(file.audit, keys.vk, AD_AUDIT) : [];
    const settings = file.settings
      ? { ...structuredClone(DEFAULT_SETTINGS), ...decryptJson<Partial<VaultSettings>>(file.settings, keys.vk, AD_SETTINGS) }
      : structuredClone(DEFAULT_SETTINGS);
    // v1 → v2 migration is implicit: no tombstones existed, so the list starts empty.
    // Expired tombstones are garbage-collected on open by whichever device notices first.
    const cutoff = new Date(Date.parse(now()) - TOMBSTONE_RETENTION_DAYS * 86_400_000);
    const deletions: Tombstone[] = [];
    let forgedTombstones = 0;
    for (const sealed of file.deletions ?? []) {
      let t: Tombstone;
      try {
        t = openTombstone(sealed, keys.vk);
      } catch {
        // Failed authentication means forged or corrupted — never act on it, but never
        // pretend it did not happen either: a forged deletion is an attack signal.
        forgedTombstones++;
        continue;
      }
      if (new Date(t.deletedAt) >= cutoff) deletions.push(t);
    }
    // Seed the ciphertext cache from the file: every item is clean at open time, so nothing
    // is re-encrypted until it is actually edited.
    const ctCache = new Map(file.items.map((e) => [e.id, e.ct]));
    const store = new VaultStore(
      file.header, keys, items, audit, settings, storage, now,
      "password" in credential ? "password" : "recovery",
      deviceId, deletions, ctCache,
    );
    // Recovery-stripping detection: the encrypted settings remember which recovery key
    // should exist; if the plaintext header no longer agrees, the file was tampered with.
    if (settings.recoveryKeyId && file.header.recovery?.keyId !== settings.recoveryKeyId) {
      store.integrityWarnings.push(
        "This vault previously had a recovery key configured, but its recovery data is now missing or altered. " +
          "The vault file may have been tampered with. Create a fresh recovery kit now, and treat old kits as invalid.",
      );
    }
    if (forgedTombstones > 0) {
      store.integrityWarnings.push(
        `${forgedTombstones} deletion record(s) in this vault failed their integrity check and were ignored. ` +
          "Someone may have tried to make this device delete entries. Nothing was deleted.",
      );
    }
    if ("recoveryKey" in credential) {
      store.log("recovery_unlock");
      await store.persist();
    }
    return store;
  }

  /** Non-empty if the vault file shows signs of tampering — shells must surface these. */
  getIntegrityWarnings(): string[] {
    return [...this.integrityWarnings];
  }

  // ---- serialization -------------------------------------------------------

  /** Cached ciphertext for a clean item; encrypt (and cache) only if it was marked dirty. */
  private ciphertextFor(item: VaultItem): Ciphertext {
    const cached = this.ctCache.get(item.id);
    if (cached) return cached;
    const ct = encryptJson(item, this.keys.vk, adItem(item.id));
    this.ctCache.set(item.id, ct);
    return ct;
  }

  serialize(): string {
    const file: VaultFile = {
      format: "pwm-vault",
      fileVersion: VAULT_FILE_VERSION,
      header: this.header,
      items: [...this.items.values()].map((item) => ({
        id: item.id,
        ct: this.ciphertextFor(item),
      })),
      deletions: [...this.deletions.values()].map((t) => sealTombstone(t, this.keys.vk)),
      audit: encryptJson(this.audit, this.keys.vk, AD_AUDIT),
      settings: encryptJson(this.settings, this.keys.vk, AD_SETTINGS),
    };
    return JSON.stringify(file);
  }

  async persist(): Promise<void> {
    await this.storage.save(this.serialize());
  }

  getHeader(): VaultHeader {
    return this.header;
  }

  /** Exposed for backup packaging only. */
  getBackupKey(): Uint8Array {
    return this.keys.bk;
  }

  /**
   * Exposed so a caller can share the already-derived Vault Key with a trusted, platform-gated
   * store outside core — e.g. apps/mobile's biometric.ts writes this into a Face ID/passcode-
   * protected shared Keychain item (App Group access group) so the iOS AutoFill credential
   * provider extension can decrypt items without re-deriving the KEK. No encryption/decryption
   * logic changes here; this only exposes existing key material, mirroring getBackupKey().
   */
  getVaultKey(): Uint8Array {
    return this.keys.vk;
  }

  lock(): void {
    wipe(this.keys.vk);
    wipe(this.keys.bk);
    this.items.clear();
  }

  // ---- items ---------------------------------------------------------------

  // Public accessors hand out DEEP CLONES, never the live objects. A caller that mutated a
  // returned item (or its nested fields) would bypass markDirty(), so serialize() would emit
  // the stale cached ciphertext while the UI showed the new value — the edit would be
  // silently lost on the next persist or sync. Cloning makes that mistake impossible.
  listItems(opts?: { includeArchived?: boolean }): VaultItem[] {
    const all = [...this.items.values()];
    const visible = opts?.includeArchived ? all : all.filter((i) => !i.archived);
    return visible.map((i) => structuredClone(i));
  }

  getItem(id: string): VaultItem | undefined {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async addItem(input: NewItemInput): Promise<VaultItem> {
    const t = this.now();
    const item: VaultItem = {
      id: randomId(),
      type: input.type,
      title: input.title,
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      favorite: input.favorite ?? false,
      archived: false,
      // Clone caller-supplied nested values: keeping the caller's own objects would let
      // them mutate vault state from outside without invalidating the ciphertext cache.
      fields: structuredClone(input.fields ?? {}),
      customFields: structuredClone(input.customFields ?? []),
      notes: input.notes ?? "",
      reminders: input.reminders ?? [],
      passwordHistory: [],
      versions: [],
      createdAt: t,
      updatedAt: t,
      lastUsedAt: null,
    };
    this.items.set(item.id, item);
    this.deletions.delete(item.id);
    this.markDirty(item.id);
    this.log("item_created", item.title);
    await this.persist();
    return structuredClone(item);
  }

  async updateItem(
    id: string,
    changes: Partial<Omit<VaultItem, "id" | "createdAt" | "versions" | "passwordHistory">>,
  ): Promise<VaultItem> {
    const item = this.items.get(id);
    if (!item) throw new Error("Item not found");
    const t = this.now();

    // Version snapshot + password history for changed password fields.
    item.versions.unshift({ savedAt: item.updatedAt, fields: { ...item.fields }, notes: item.notes });
    item.versions = item.versions.slice(0, MAX_VERSIONS_PER_ITEM);
    if (changes.fields) {
      for (const def of TEMPLATES[item.type].fields) {
        if (!def.isPassword) continue;
        const oldVal = item.fields[def.key];
        const newVal = changes.fields[def.key];
        if (oldVal && newVal !== undefined && newVal !== oldVal) {
          item.passwordHistory.unshift({ value: oldVal, changedAt: t });
          item.passwordHistory = item.passwordHistory.slice(0, MAX_PASSWORD_HISTORY);
        }
      }
    }

    Object.assign(item, structuredClone(changes), { updatedAt: t });
    this.markDirty(id);
    this.log("item_edited", item.title);
    await this.persist();
    return structuredClone(item);
  }

  async deleteItem(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    this.markDirty(id);
    // Tombstone, not a silent drop: another device holding this item must not resurrect it.
    this.deletions.set(id, { id, deletedAt: this.now(), deviceId: this.deviceId });
    this.log("item_deleted", item.title);
    await this.persist();
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    item.archived = archived;
    item.updatedAt = this.now();
    this.markDirty(id);
    this.log(archived ? "item_archived" : "item_restored", item.title);
    await this.persist();
  }

  async touchUsed(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    item.lastUsedAt = this.now();
    this.markDirty(id);
    await this.persist();
  }

  /** Search over titles, tags, folders and non-sensitive field values only. */
  search(query: string): VaultItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.listItems();
    const sensitiveKeys = new Map(
      Object.values(TEMPLATES).map((t) => [
        t.type,
        new Set(t.fields.filter((f) => f.sensitive).map((f) => f.key)),
      ]),
    );
    return this.listItems().filter((item) => {
      if (item.title.toLowerCase().includes(q)) return true;
      if (item.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
      if (item.folder?.toLowerCase().includes(q)) return true;
      const sensitive = sensitiveKeys.get(item.type)!;
      return Object.entries(item.fields).some(
        ([k, v]) => !sensitive.has(k) && v.toLowerCase().includes(q),
      );
    });
  }

  // ---- settings / audit ----------------------------------------------------

  async updateSettings(changes: Partial<VaultSettings>): Promise<void> {
    this.settings = { ...this.settings, ...changes };
    await this.persist();
  }

  log(type: AuditEventType, detail?: string): void {
    this.audit.unshift({ at: this.now(), type, ...(detail ? { detail } : {}) });
    this.audit = this.audit.slice(0, MAX_AUDIT_EVENTS);
  }

  async logAndPersist(type: AuditEventType, detail?: string): Promise<void> {
    this.log(type, detail);
    await this.persist();
  }

  getAudit(): AuditEvent[] {
    return [...this.audit];
  }

  async clearAudit(): Promise<void> {
    this.audit = [];
    this.log("history_cleared");
    await this.persist();
  }

  // ---- sync surface (V2) ---------------------------------------------------
  // These exist so packages/sync can push/pull per-item ciphertext and merge decrypted
  // items WITHOUT re-implementing any crypto. All encryption stays here, under VK.

  getDeviceId(): string {
    return this.deviceId;
  }

  getDeletions(): Tombstone[] {
    return [...this.deletions.values()];
  }

  /** Sealed tombstones for upload — the server never sees a deletion time or device. */
  getSealedDeletions(): SealedTombstone[] {
    return [...this.deletions.values()].map((t) => sealTombstone(t, this.keys.vk));
  }

  /**
   * Authenticate a tombstone pulled from the server. Throws if it was forged or altered,
   * which is the whole defence against a malicious server deleting credentials remotely.
   */
  openSealedTombstone(sealed: SealedTombstone): Tombstone {
    return openTombstone(sealed, this.keys.vk);
  }

  /** Per-item ciphertext for upload. Uses the cache, so clean items keep a stable ct. */
  getItemCiphertexts(): { id: string; ct: Ciphertext }[] {
    return [...this.items.values()].map((item) => ({ id: item.id, ct: this.ciphertextFor(item) }));
  }

  /** Decrypt an item pulled from the server. Throws if the ciphertext fails authentication. */
  decryptItem(id: string, ct: Ciphertext): VaultItem {
    return decryptJson<VaultItem>(ct, this.keys.vk, adItem(id));
  }

  /**
   * Replace the whole item set and tombstone list after a merge, in one persist. The caller
   * (packages/sync) has already decided the outcome; this only commits it. Ciphertext for
   * items whose object identity is unchanged stays cached, so an incoming merge does not
   * churn every ciphertext.
   */
  async applyMerge(
    items: VaultItem[],
    deletions: Tombstone[],
    changedIds: Iterable<string>,
  ): Promise<void> {
    for (const id of changedIds) this.markDirty(id);
    this.items = new Map(items.map((i) => [i.id, structuredClone(i)]));
    this.deletions = new Map(deletions.map((d) => [d.id, d]));
    // Drop cache entries for items that no longer exist.
    for (const id of [...this.ctCache.keys()]) if (!this.items.has(id)) this.ctCache.delete(id);
    await this.persist();
  }

  /** Replace the header after pulling a remote password/recovery change. Keys are unchanged. */
  setHeader(header: VaultHeader): void {
    this.header = header;
  }

  getSettings(): VaultSettings {
    return structuredClone(this.settings);
  }

  // ---- keys / recovery -----------------------------------------------------

  /**
   * Reauth is enforced HERE, not trusted to the UI: pass the master password (verified
   * against the header), except when the vault was opened with the recovery key — that
   * unlock already proved the stronger credential (this is the forgot-password flow).
   */
  private requireReauth(reauth?: Reauth): void {
    if (this.unlockedVia === "recovery") return;
    if (!reauth || !verifyMasterPassword(this.header, reauth.masterPassword)) {
      throw new ReauthRequiredError();
    }
  }

  /** Create or rotate the recovery key. Requires reauthentication. */
  async createRecoveryKey(reauth?: Reauth): Promise<string> {
    this.requireReauth(reauth);
    const rotating = !!this.header.recovery;
    const { header, recoveryKey } = setupRecoveryKey(this.header, this.keys, this.now());
    this.header = header;
    this.settings.recoveryKeyId = header.recovery!.keyId;
    this.log(rotating ? "recovery_key_rotated" : "recovery_key_created");
    await this.persist();
    return recoveryKey;
  }

  /** Change the master password. Requires reauthentication (see requireReauth). */
  async changeMasterPassword(newPassword: string, reauth?: Reauth): Promise<void> {
    this.requireReauth(reauth);
    this.header = rewrapWithNewPassword(this.header, this.keys, newPassword);
    this.log("master_password_changed");
    await this.persist();
  }
}

function normalizeOptions(
  nowOrOpts: (() => string) | VaultStoreOptions,
): { now: () => string; deviceId: string } {
  const opts: VaultStoreOptions = typeof nowOrOpts === "function" ? { now: nowOrOpts } : nowOrOpts;
  return {
    now: opts.now ?? (() => new Date().toISOString()),
    // "local" is the pre-sync default: single-device vaults never compare device ids.
    deviceId: opts.deviceId ?? "local",
  };
}

export function parseVaultFile(serialized: string): VaultFile {
  let file: VaultFile;
  try {
    file = JSON.parse(serialized) as VaultFile;
  } catch {
    throw new Error("Not a valid vault file (corrupt JSON).");
  }
  if (file?.format !== "pwm-vault" || file.header?.version !== 1)
    throw new Error("Not a valid vault file (unknown format or version).");
  return file;
}

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
  VaultItem,
  VaultSettings,
} from "./model";
import { TEMPLATES } from "./templates";

export interface VaultFile {
  format: "pwm-vault";
  header: VaultHeader;
  items: { id: string; ct: Ciphertext }[];
  audit: Ciphertext | null;
  settings: Ciphertext | null;
}

export interface StorageAdapter {
  save(serialized: string): Promise<void>;
}

const adItem = (id: string) => `item:${id}`;
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

  private constructor(
    header: VaultHeader,
    keys: UnlockedKeys,
    items: VaultItem[],
    audit: AuditEvent[],
    settings: VaultSettings,
    storage: StorageAdapter,
    now: () => string,
    unlockedVia: "password" | "recovery",
  ) {
    this.header = header;
    this.keys = keys;
    this.items = new Map(items.map((i) => [i.id, i]));
    this.audit = audit;
    this.settings = settings;
    this.storage = storage;
    this.now = now;
    this.unlockedVia = unlockedVia;
  }

  static async create(
    masterPassword: string,
    storage: StorageAdapter,
    now: () => string = () => new Date().toISOString(),
  ): Promise<VaultStore> {
    const { header, keys } = createVaultHeader(masterPassword, now());
    const store = new VaultStore(header, keys, [], [], structuredClone(DEFAULT_SETTINGS), storage, now, "password");
    store.log("vault_created");
    await store.persist();
    return store;
  }

  static async open(
    serialized: string,
    credential: { password: string } | { recoveryKey: string },
    storage: StorageAdapter,
    now: () => string = () => new Date().toISOString(),
  ): Promise<VaultStore> {
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
    const store = new VaultStore(
      file.header, keys, items, audit, settings, storage, now,
      "password" in credential ? "password" : "recovery",
    );
    // Recovery-stripping detection: the encrypted settings remember which recovery key
    // should exist; if the plaintext header no longer agrees, the file was tampered with.
    if (settings.recoveryKeyId && file.header.recovery?.keyId !== settings.recoveryKeyId) {
      store.integrityWarnings.push(
        "This vault previously had a recovery key configured, but its recovery data is now missing or altered. " +
          "The vault file may have been tampered with. Create a fresh recovery kit now, and treat old kits as invalid.",
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

  serialize(): string {
    const file: VaultFile = {
      format: "pwm-vault",
      header: this.header,
      items: [...this.items.values()].map((item) => ({
        id: item.id,
        ct: encryptJson(item, this.keys.vk, adItem(item.id)),
      })),
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

  lock(): void {
    wipe(this.keys.vk);
    wipe(this.keys.bk);
    this.items.clear();
  }

  // ---- items ---------------------------------------------------------------

  listItems(opts?: { includeArchived?: boolean }): VaultItem[] {
    const all = [...this.items.values()];
    return opts?.includeArchived ? all : all.filter((i) => !i.archived);
  }

  getItem(id: string): VaultItem | undefined {
    return this.items.get(id);
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
      fields: input.fields ?? {},
      customFields: input.customFields ?? [],
      notes: input.notes ?? "",
      reminders: input.reminders ?? [],
      passwordHistory: [],
      versions: [],
      createdAt: t,
      updatedAt: t,
      lastUsedAt: null,
    };
    this.items.set(item.id, item);
    this.log("item_created", item.title);
    await this.persist();
    return item;
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

    Object.assign(item, changes, { updatedAt: t });
    this.log("item_edited", item.title);
    await this.persist();
    return item;
  }

  async deleteItem(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    this.log("item_deleted", item.title);
    await this.persist();
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    item.archived = archived;
    item.updatedAt = this.now();
    this.log(archived ? "item_archived" : "item_restored", item.title);
    await this.persist();
  }

  async touchUsed(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    item.lastUsedAt = this.now();
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

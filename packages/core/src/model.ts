// Vault data model. Entities beyond V1 scope (TrustedContact, EmergencyAccessRequest, …)
// are deliberately absent; the item/versions/audit shapes match SPEC § Data Model.

export type ItemType =
  | "login"
  | "netbanking"
  | "upi"
  | "card"
  | "demat"
  | "govid"
  | "note"
  | "wifi"
  | "insurance"
  | "custom";

export interface CustomField {
  label: string;
  value: string;
  sensitive: boolean;
}

export interface Reminder {
  label: string;
  /** ISO date (YYYY-MM-DD) */
  date: string;
}

export interface PasswordHistoryEntry {
  value: string;
  changedAt: string;
}

export interface ItemVersion {
  savedAt: string;
  /** Snapshot of fields + notes before an edit. */
  fields: Record<string, string>;
  notes: string;
}

export interface VaultItem {
  id: string;
  type: ItemType;
  title: string;
  folder: string | null;
  tags: string[];
  favorite: boolean;
  archived: boolean;
  /** Template field values, keyed by field key from templates.ts. */
  fields: Record<string, string>;
  customFields: CustomField[];
  notes: string;
  reminders: Reminder[];
  passwordHistory: PasswordHistoryEntry[];
  versions: ItemVersion[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export type AuditEventType =
  | "vault_created"
  | "item_created"
  | "item_edited"
  | "item_viewed"
  | "item_deleted"
  | "item_archived"
  | "item_restored"
  | "sensitive_revealed"
  | "password_copied"
  | "backup_completed"
  | "backup_failed"
  | "restore_completed"
  | "recovery_key_created"
  | "recovery_key_rotated"
  | "recovery_key_viewed"
  | "recovery_unlock"
  | "master_password_changed"
  | "failed_unlock"
  | "emergency_kit_exported"
  | "history_cleared"
  | "items_imported";

export interface AuditEvent {
  at: string;
  type: AuditEventType;
  /** Item title or short human note — never secret values. */
  detail?: string;
}

export interface VaultSettings {
  clipboardClearSeconds: number;
  autoLockMinutes: number;
  backup: {
    frequency: "daily" | "weekly" | "monthly" | "manual";
    retention: number;
    lastSuccessAt: string | null;
    lastError: string | null;
    driveFolderId: string | null;
    wifiOnly: boolean;
  };
  ownerName: string;
  emergencyContact: string;
  /**
   * Recorded inside the ENCRYPTED settings when a recovery key is created. If the plaintext
   * header's recovery envelopes later disappear or change without this being updated, the
   * vault file was tampered with (recovery stripping) — surfaced as an integrity warning.
   */
  recoveryKeyId: string | null;
}

export const DEFAULT_SETTINGS: VaultSettings = {
  clipboardClearSeconds: 30,
  autoLockMinutes: 5,
  backup: {
    frequency: "weekly", // spec's recommended default
    retention: 7,
    lastSuccessAt: null,
    lastError: null,
    driveFolderId: null,
    wifiOnly: false,
  },
  ownerName: "",
  emergencyContact: "",
  recoveryKeyId: null,
};

export const MAX_VERSIONS_PER_ITEM = 20;
export const MAX_PASSWORD_HISTORY = 20;
export const MAX_AUDIT_EVENTS = 1000;

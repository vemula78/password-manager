// Fill-refusal policy (SPEC § Browser Extension: "For Indian banking sites, use stricter
// autofill behaviour" + acceptance criteria: "refuses or warns before autofilling banking
// transaction fields"). Pure logic built on top of @pw/core's field templates so refusal
// stays in sync with whatever fields the templates define — no separate hard-coded list to
// drift out of date. Kept dependency-free apart from @pw/core so it's directly unit-testable.
import { TEMPLATES, type ItemType } from "@pw/core";

/**
 * Field keys that are refused for autofill even though their template `kind` alone wouldn't
 * catch them (transaction/profile passwords are `kind: "password"`, not `"pin"`, but the spec
 * explicitly calls them out as reveal/copy-only).
 */
const EXPLICIT_NEVER_AUTOFILL_KEYS = new Set(["transactionPassword", "profilePassword"]);

/**
 * True if this template field must never be auto-filled into a page — it is copy/reveal-only
 * in the popup, gated by master-password reauthentication. Covers: any `kind: "pin"` field
 * (MPIN, TPIN, CVV, ATM PIN, ...) plus explicitly named transaction/profile passwords.
 */
export function isFillRefusedField(itemType: ItemType, fieldKey: string): boolean {
  const field = TEMPLATES[itemType]?.fields.find((f) => f.key === fieldKey);
  if (!field) return false;
  if (field.kind === "pin") return true;
  return EXPLICIT_NEVER_AUTOFILL_KEYS.has(fieldKey);
}

/** Item types treated as banking/government — SPEC: require a per-fill confirmation showing
 * the domain even for an ordinary (non-sensitive) login fill. */
export const BANKING_OR_GOV_TYPES: ReadonlySet<ItemType> = new Set(["netbanking", "demat", "govid"]);

export function requiresPerFillConfirmation(itemType: ItemType): boolean {
  return BANKING_OR_GOV_TYPES.has(itemType);
}

/** Every fill-refused field key for a given item type — used to filter what a "Fill" action
 * is even allowed to consider sending to the page. */
export function fillRefusedKeysFor(itemType: ItemType): string[] {
  const tpl = TEMPLATES[itemType];
  if (!tpl) return [];
  return tpl.fields.filter((f) => isFillRefusedField(itemType, f.key)).map((f) => f.key);
}

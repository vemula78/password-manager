// Which template field counts as "the" username/password for the Fill action, per item type.
// Deliberately picks the ordinary login credential, never a transaction/profile password,
// PIN, or CVV — those are excluded by construction here and double-checked against
// isFillRefusedField in the background handler before anything is sent to a page.
import type { ItemType } from "@pw/core";

interface FillableKeys {
  usernameKey: string | null;
  passwordKey: string | null;
}

const MAP: Partial<Record<ItemType, FillableKeys>> = {
  login: { usernameKey: "username", passwordKey: "password" },
  netbanking: { usernameKey: "customerId", passwordKey: "loginPassword" },
  demat: { usernameKey: "clientId", passwordKey: "loginPassword" },
  govid: { usernameKey: "portalUsername", passwordKey: "portalPassword" },
  insurance: { usernameKey: "portalUsername", passwordKey: "portalPassword" },
  wifi: { usernameKey: null, passwordKey: "password" },
};

export function fillableFieldsFor(itemType: ItemType): FillableKeys {
  return MAP[itemType] ?? { usernameKey: null, passwordKey: null };
}

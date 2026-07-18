// Input shape for syncCredentialIdentities — one entry per Login item that has both a
// non-empty url and username. Filtering (type === "login", host/username presence) happens in
// JS (apps/mobile/src/security/identitySync.ts) before crossing the native bridge.
export interface CredentialIdentityInput {
  id: string;
  username: string;
  host: string;
}

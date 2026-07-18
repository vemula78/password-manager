// Biometric unlock — the standard mobile password-manager pattern:
//
//   1. The user unlocks once with the master password.
//   2. If they opt in, the master password is stored in the device Keychain/Keystore via
//      expo-secure-store with `requireAuthentication: true` and
//      WHEN_UNLOCKED_THIS_DEVICE_ONLY — hardware-backed, never synced/backed up off-device,
//      and readable only after a successful biometric (or device credential) prompt.
//   3. On later launches, a Face ID / fingerprint prompt releases the stored password,
//      which is fed through @pw/core's normal Argon2id unlock. The vault file format and
//      key hierarchy are untouched — biometrics only gate access to the cached credential.
//   4. Disabling the toggle deletes the SecureStore entry; nothing else needs rotating.
//
// The vault keys themselves are never stored on their own — only the master password, behind
// the platform biometric gate — EXCEPT on iOS, where enabling biometrics ALSO writes the raw
// Vault Key (VK) into a separate, Face ID/passcode-gated Keychain item in the shared App Group
// access group (see modules/shared-vault-store). That is what lets the credentials-provider
// AutoFill extension — a different OS process, with no access to expo-secure-store's
// app-private Keychain item — decrypt items after its own biometric prompt, without needing the
// master password at all. Nothing about the KEK/VK/BK hierarchy or ciphertext format changes;
// this only mirrors already-derived key material into a second, equally biometric-gated home.
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import SharedVaultStore from "../../modules/shared-vault-store/src/SharedVaultStoreModule";

const MASTER_PW_KEY = "pwm.master_password";

export async function biometricsAvailable(): Promise<boolean> {
  return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
}

/** "Face ID" / "Touch ID" / "Biometric unlock" — for button labels. */
export async function biometricLabel(): Promise<string> {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return "Face ID";
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return "Touch ID / fingerprint";
  return "Biometric unlock";
}

/** Prompt for biometrics; true on success. Used to gate reveal/copy of sensitive fields. */
export async function promptBiometric(reason: string): Promise<boolean> {
  const res = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
  return res.success;
}

export async function storeMasterPassword(password: string): Promise<void> {
  await SecureStore.setItemAsync(MASTER_PW_KEY, password, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Read the stored master password. The SecureStore read itself triggers the OS biometric
 * prompt (requireAuthentication: true). Returns null on cancel/failure/missing.
 */
export async function readMasterPassword(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(MASTER_PW_KEY, {
      requireAuthentication: true,
      authenticationPrompt: "Unlock your vault",
    });
  } catch {
    return null;
  }
}

export async function clearStoredMasterPassword(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(MASTER_PW_KEY);
  } catch {
    // already gone
  }
}

// ---- iOS-only: shared Vault Key for the AutoFill credential provider extension ------------
//
// toB64 uses libsodium's ORIGINAL (standard, padded) base64 variant — the same encoding
// swift-sodium / Foundation's `Data(base64Encoded:)` expect, so no re-encoding is needed on
// the Swift side.
import { toB64 } from "@pw/core";

/**
 * Mirror the Vault Key into the shared, Face ID/passcode-gated Keychain item so the
 * credentials-provider extension can decrypt items on its own. No-op on Android (no AutoFill
 * provider integration there) and swallows errors from environments without the native module
 * (e.g. Expo Go) — biometric unlock of the main app still works either way.
 *
 * IMPORTANT: `vk` here is expected to be the SAME Uint8Array reference VaultStore.getVaultKey()
 * returns, i.e. the live key VaultStore uses for every encrypt/decrypt. Do NOT wipe() it here —
 * that would zero the vault's in-memory key out from under it. Only VaultStore.lock() may wipe
 * this array.
 */
export async function storeSharedVaultKey(vk: Uint8Array): Promise<void> {
  if (Platform.OS !== "ios") return;
  const b64 = toB64(vk);
  await SharedVaultStore.storeSharedVaultKey(b64);
}

/**
 * Delete the shared Keychain vault-key item. Called whenever biometrics are disabled (or a
 * stale-credential situation revokes them — see VaultContext.tsx's unlockWithBiometrics).
 *
 * Does NOT swallow errors: a failed Keychain delete means AutoFill access was NOT actually
 * revoked, so callers (VaultContext.tsx's disableBiometrics) must see the failure and avoid
 * recording biometricEnabled: false as if revocation succeeded. This mirrors
 * storeSharedVaultKey above, which also lets native errors propagate.
 */
export async function deleteSharedVaultKey(): Promise<void> {
  if (Platform.OS !== "ios") return;
  await SharedVaultStore.deleteSharedVaultKey();
}

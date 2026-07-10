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
// The vault keys themselves are never stored — only the master password, behind the
// platform biometric gate.
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";

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

# iOS AutoFill credential provider — Praveen's Xcode setup (18-Jul-2026)

Summary: the credentials-provider extension target, shared App Group storage, shared-Keychain
Vault Key, and identity-store sync are all coded (see file list at the bottom). None of it has
been run on real Xcode/CocoaPods/a device — this machine only has Command Line Tools, no full
Xcode.app, no CocoaPods (`pod` not found). Everything below is the click-by-click path to get
from "code exists" to "AutoFill actually fills a password on my phone."

**Side effect of installing `@bacons/apple-targets`**: `apps/mobile/package.json`'s `ios`/
`android` scripts changed from `expo start --ios`/`--android` to `expo run:ios`/`expo
run:android`. That's the `create-target`/`create-expo-module` tooling adjusting the dev workflow
for a project that now has custom native code (the extension target + the local
shared-vault-store module) — `expo start` alone (Expo Go / a stale dev client) can't load them;
`expo run:ios` rebuilds and launches the real native project. You'll use `expo run:ios` (or just
build from Xcode directly, which is equivalent) from now on for local development.

## 1. Install full Xcode + CocoaPods

1. Open the **App Store** app on the Mac, search "Xcode", install it (large download, ~15 GB).
   Alternatively download from https://developer.apple.com/xcode/ if the App Store version lags.
2. Launch Xcode once so it finishes installing additional components (it'll prompt you).
3. Install CocoaPods: open Terminal and run:
   ```sh
   sudo gem install cocoapods
   ```
   (or `brew install cocoapods` if you prefer Homebrew — either is fine.)
4. Verify: `xcode-select -p` should print something like
   `/Applications/Xcode.app/Contents/Developer` (not `.../CommandLineTools`), and `pod --version`
   should print a version number.

## 2. Set your Apple Team ID

`app.json` does not have `ios.appleTeamId` set yet — prebuild already warned about this
("Expo config is missing required ios.appleTeamId property").

1. Open Xcode → **Xcode menu → Settings… → Accounts** tab.
2. Make sure your Apple ID is signed in (add it with the `+` button if not).
3. Select your Apple ID, and in the right-hand pane your **Team** is listed with a Team ID next
   to it (a 10-character alphanumeric string, e.g. `A1B2C3D4E5`).
4. Add it to `apps/mobile/app.json`:
   ```json
   "ios": {
     ...
     "appleTeamId": "A1B2C3D4E5"
   }
   ```
   (You can also find/confirm this later inside the generated Xcode project, under each
   target's **Signing & Capabilities** tab, once you've opened it in step 4 below.)

## 3. Add the swift-sodium package to the credentials-provider target

`@bacons/apple-targets` does not have a declarative way to add Swift Package dependencies to a
specific target (no `dependencies:` key in `expo-target.config.js`), so this is a one-time
manual step in Xcode, done **after** step 4's prebuild:

1. Open the project in Xcode (step 4).
2. Select the project in the navigator → select the **credentials-provider** target → the
   **General** tab (or **Package Dependencies** tab at the project level).
3. File menu → **Add Package Dependencies…**
4. Enter the URL: `https://github.com/jedisct1/swift-sodium`
5. Choose "Up to Next Major Version" and add it.
6. **Important**: when Xcode asks which target(s) to add the package product ("Sodium") to,
   check **only credentials-provider** — the main app doesn't need it (it uses
   react-native-libsodium via JS, not swift-sodium).
7. Re-run this step if you ever do a fresh `npx expo prebuild --clean` that recreates the
   `ios/` project from scratch (SPM package references live in the generated
   `.xcodeproj`, not in `targets/`, so they don't survive a clean prebuild).

## 4. Generate and open the Xcode project

From `apps/mobile`:
```sh
npx expo prebuild --clean
```
This regenerates `ios/`, links the `credentials-provider` target, and writes the entitlements
files. See "What I actually ran" below for exactly how far this got on this machine (it stopped
at the CocoaPods step, which needs the real Xcode + CocoaPods from step 1).

Then open the project:
```sh
xed ios
```
This opens `ios/PasswordVault.xcworkspace` (or `.xcodeproj` if prebuild didn't get far enough to
create pods) in Xcode.

## 5. Fix signing for both targets

1. In Xcode's navigator, select the project → the **PasswordVault** (main app) target →
   **Signing & Capabilities** tab.
2. Make sure "Automatically manage signing" is on and your Team is selected (should already
   match `appleTeamId` from step 2 — if Xcode shows a different/no team, fix it here and Xcode
   will offer to update `app.json` for you, or update it by hand to match).
3. Confirm two capabilities are listed: **App Groups** (`group.org.pwmanager.vault`) and
   **AutoFill Credential Provider**. If App Groups shows an error ("no group selected" or
   similar), click it and re-select/re-add `group.org.pwmanager.vault` — the first time a new
   App Group ID is used on your account, Xcode/the Apple Developer portal has to register it,
   which requires being online and signed in.
4. Repeat steps 1–3 for the **credentials-provider** target (same Team, same two capabilities
   should already be present from `targets/credentials-provider/expo-target.config.js`).

## 6. Build to your device

1. Plug in your iPhone ("Praveen"), select it as the run destination in Xcode's toolbar (not a
   simulator — Face ID and the real Keychain access-group behavior need a real device; the
   simulator's Face ID is unreliable for this kind of testing).
2. Press Run (▶) with the **PasswordVault** scheme selected. First run on the device may prompt
   you to trust the developer certificate: **Settings → General → VPN & Device Management** on
   the phone → trust your Apple ID/team.
3. The credentials-provider extension is bundled inside the app automatically — you don't run it
   directly; iOS launches it when needed (see step 7).

## 7. Turn on the AutoFill provider (no programmatic deep link exists for this — Apple only
   exposes it as a manual Settings toggle)

1. On the iPhone: **Settings → Passwords**.
2. Tap **AutoFill Passwords & Passkeys** (this exact label varies a little by iOS version —
   on some iOS 17/18 builds it's **Password Options**).
3. You'll see a list of apps that can act as AutoFill providers, alongside "iCloud Passwords &
   Keychain". Toggle **Password Vault** ON. You can leave iCloud Keychain on too — both can be
   active AutoFill providers at once, and iOS shows suggestions from all enabled providers.
4. Open Password Vault once, unlock it with your master password, and turn on **Face ID
   unlock** in Settings inside the app if you haven't already — this is what populates the
   shared Keychain item the extension needs (see "How biometrics gate this" below). Without
   this step, AutoFill will show your logins in the picker but every fill will fail closed at
   the Face ID prompt because there's no shared key to unlock with.
5. Test it: open Safari, go to a site you've saved a login for, tap the username field. You
   should see a key icon / QuickType suggestion. Tapping it (or the key icon → your saved item)
   should prompt Face ID and then fill in.

## How biometrics gate this (so you know what "not working" looks like)

- Enabling Face ID unlock in the app (Settings screen) now does two things: stores the master
  password in the app-private Keychain (unchanged, as before), AND writes the raw Vault Key into
  a **separate** Keychain item shared with the extension (`kSecAttrAccessGroup:
  group.org.pwmanager.vault`), protected by a `SecAccessControl` requiring Face ID/Touch ID/
  passcode (`.userPresence`).
- Turning Face ID unlock OFF deletes both.
- If you've never turned on Face ID unlock in the app, the extension has nothing to read and
  will show an empty/failing list — that's expected, not a bug.
- If you change your master password, the shared Vault Key does NOT need re-syncing (it isn't
  derived from the password — the master password only unwraps it via the KEK once per
  unlock), so there's nothing to do there. Only enable/disable of the Face ID toggle
  writes/deletes the shared key.

## What I actually ran, and where it stopped

- `packages/core`: `npx vitest run` → **51/51 tests passed** (includes the new `getVaultKey()`
  getter — no encryption/decryption logic touched, only an additive key-exposure method
  mirroring the existing `getBackupKey()`).
- `apps/mobile`: `npx tsc --noEmit` → **clean, no errors**.
- `apps/mobile`: `npx expo prebuild --clean` → ran without a full Xcode/CocoaPods install
  present, so see the live output for the exact stopping point; expected to succeed at
  generating `ios/PasswordVault.xcodeproj` and linking the `credentials-provider` target
  (Info.plist, entitlements, Swift files), then fail at the `pod install` step since `pod` is
  not installed on this machine. That failure is expected per the task brief, not a defect —
  the fix is step 1 above.
- Re-ran after the 18-Jul-2026 security-review fixes: `npx expo prebuild --clean` regenerated
  `ios/` and linked the `credentials-provider` target the same way as before (confirmed
  `INFOPLIST_FILE` in the generated `.pbxproj` points at the checked-in
  `targets/credentials-provider/Info.plist`, carrying the new `NSFaceIDUsageDescription` key).
  This run actually got a bit further than before — it managed to auto-install the CocoaPods CLI
  via Homebrew — but still failed at `pod install` itself with
  `xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory
  '/Library/Developer/CommandLineTools' is a command line tools instance`. Same root cause as
  before (no full Xcode.app on this machine, only Command Line Tools) — step 1 above is still
  the fix, nothing new to do here.

## Everything unverified pending your Xcode session (read this before assuming it "just works")

This is close to everything about actual runtime behavior — none of it has run on a device:

- Whether `npx expo prebuild --clean` fully succeeds once Xcode + CocoaPods are installed, and
  whether the generated project actually links `targets/credentials-provider/*.swift` and the
  two new Swift files (`DomainMatch.swift`, `VaultAccess.swift`) into that target correctly.
- Whether the `modules/shared-vault-store` local Expo Module autolinks correctly for both the
  main app and gets its Keychain/identity-store calls compiled and callable from JS at all (this
  is the first local Expo Module in this project — no precedent in this codebase to compare
  against).
- Whether `SecAccessControl` with `.userPresence` + `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
  behaves as expected across the app/extension boundary — in particular whether
  `SecItemCopyMatching` with `kSecUseAuthenticationUI: .allow` inside
  `provideCredentialWithoutUserInteraction` actually prompts Face ID inline (this is the
  documented/intended pattern for credential providers, but Apple's real-device behavior here has
  had version-to-version quirks; if it doesn't prompt inline, the code already falls back
  cleanly to `prepareInterfaceToProvideCredential`'s Face ID retry button, so worst case is one
  extra tap, not a crash).
- Whether swift-sodium's `aead.xchacha20poly1305ietf.decrypt`/`encrypt` API signature in the
  version Xcode's package resolver picks still matches what `VaultAccess.swift` calls (written
  against the well-established `Bytes`-based API — should be stable, but package majors can
  drift).
- Whether `NSFileCoordinator` reads/writes in `VaultAccess.swift` actually prevent corruption
  when the main app is mid-`persist()` while the extension is running — this needs a real
  concurrent-access test (edit an item in the app, immediately trigger AutoFill) on a device.
- Whether the QuickType bar/key-icon list actually shows entries after `syncCredentialIdentities`
  runs — i.e. whether `ASCredentialIdentityStore.replaceCredentialIdentities` succeeds silently
  or needs additional Info.plist/entitlement wiring beyond what's here.
- The whole Face-ID-in-an-extension UX: whether the system's biometric prompt reads clearly,
  whether `prepareInterfaceToProvideCredential`'s minimal button UI looks acceptable (it's
  intentionally bare — no branding, just "Unlock with Face ID" / "Cancel").
- Whether the migration in `storage.ts` (old app-private `vault.json` → new shared-container
  `vault.json`) actually fires correctly the first time you build this onto your phone, given
  you already have a vault from before this change. Back up your phone (or at minimum note that
  the old file at the app's Documents directory is left in place, not deleted, so nothing is
  lost even if the migration has a bug) before testing this for the first time.
- Basic AutoFill UX polish (cell styling, search-as-you-type in the list, matching the rest of
  the app's Playfair/Lato/light theme) — the list/retry UI here is deliberately minimal per the
  "keep this basic" scope in the brief, not a finished design.

## Files changed/added

**Core (`packages/core/src/`)**
- `vault.ts` — added `VaultStore.getVaultKey()`, mirroring the existing `getBackupKey()`. No
  encrypt/decrypt logic changed.
- `model.ts` — added `"autofill_used"` to the `AuditEventType` union.

**Mobile app (`apps/mobile/`)**
- `app.json` — added `ios.entitlements` for App Groups
  (`group.org.pwmanager.vault`) and the AutoFill credential-provider entitlement. Still needs
  `ios.appleTeamId` (step 2 above).
- `src/storage.ts` — vault file now reads/writes in the App Group's shared container on iOS
  (via `expo-file-system`'s built-in `Paths.appleSharedContainers`, not a custom native path
  function — see the code comment for why), with one-time migration from the old app-private
  location. Android is unchanged (no App Group equivalent needed there; this feature is iOS-only).
- `src/security/biometric.ts` — enabling Face ID unlock now also writes the raw Vault Key into
  the shared Keychain item (`storeSharedVaultKey`); disabling it deletes that item too
  (`deleteSharedVaultKey`).
- `src/security/identitySync.ts` — new. Filters the vault to Login items with both a url and
  username, extracts the host, and calls the native `syncCredentialIdentities`.
- `src/vault/VaultContext.tsx` — wired `identitySync` to run after every unlock/create/restore
  and after every item-list mutation (piggybacks on the existing `refresh()`/`tick` mechanism);
  wired `storeSharedVaultKey`/`deleteSharedVaultKey` into `enableBiometrics`/`disableBiometrics`.

**Local Expo Module (`apps/mobile/modules/shared-vault-store/`)**
- `ios/SharedVaultStoreModule.swift` — `storeSharedVaultKey`, `deleteSharedVaultKey` (shared
  Keychain, access group `group.org.pwmanager.vault`, `.userPresence` access control), and
  `syncCredentialIdentities` (`ASCredentialIdentityStore.replaceCredentialIdentities`).
- `android/.../SharedVaultStoreModule.kt` — stub that throws; this feature is iOS-only and every
  JS call site branches on `Platform.OS === "ios"` first.
- `src/SharedVaultStoreModule.ts` / `.web.ts`, `src/SharedVaultStore.types.ts` — TS bindings +
  web stub (also throws; unreachable in practice).
- `ios/SharedVaultStore.podspec`, `expo-module.config.json` — module metadata (generated by
  `create-expo-module --local`, descriptions filled in).

**Credentials-provider extension (`apps/mobile/targets/credentials-provider/`)**
- `expo-target.config.js` — target type `credentials-provider`; explicitly repeats both
  entitlements (App Groups + AutoFill) since this target type isn't in
  `@bacons/apple-targets`' `appGroupsByDefault` auto-sync list.
- `Info.plist` — generated by `create-target`, unchanged (declares the credential-provider
  extension point; no `ASCredentialProviderExtensionCapabilities` needed since this is
  passwords-only, no passkeys/OTP).
- `credentials-provider.swift` — `CredentialProviderViewController`: `prepareCredentialList`,
  `provideCredentialWithoutUserInteraction`, `prepareInterfaceToProvideCredential`, plus a
  minimal list UI and Face ID retry UI.
- `VaultAccess.swift` — new. Reads/decrypts the shared vault.json (swift-sodium
  XChaCha20-Poly1305, matching `crypto.ts` exactly), reads the shared Keychain Vault Key,
  appends `"autofill_used"` audit events via `NSFileCoordinator`.
- `DomainMatch.swift` — new. Ports `compareHosts`'s asymmetric exact/subdomain/mismatch rule
  from `apps/extension/src/lib/domain.ts`.

**Not built**: no passkey support, no TOTP/one-time-code provision, no settings UI inside the
extension beyond the Face ID retry button — all per the "keep this basic" scope in the brief.

## Security review fixes (18-Jul-2026)

A Codex adversarial review found several real issues in the code above; here's what changed and
what it means for your Xcode setup steps.

- **Host matching is stricter now.** `DomainMatch.swift` gained `canonicalHost(from:)`, which
  reads `ASCredentialServiceIdentifier.type` properly (`.domain` vs `.URL`) instead of trusting
  the raw string, rejects IP-literal hosts unless they match exactly, and is applied to every
  identifier iOS provides (not just the first). No Xcode-side action needed — pure Swift logic.
- **QuickType/interactive fill now re-verifies the host** against the item's current decrypted
  URL before handing back a credential, closing a gap where an edited login could stale-fill
  under its old hostname. No Xcode action needed.
- **`provideCredentialWithoutUserInteraction` no longer allows Face ID from inside itself**
  (`allowUI: false`) — matches Apple's documented "no UI" contract for that callback more
  strictly. If a saved login previously auto-filled without ANY Face ID prompt from the
  QuickType bar, you'll now sometimes see the interactive Face ID retry screen instead — that's
  expected, not a regression.
- **`NSFaceIDUsageDescription` was added directly to `targets/credentials-provider/Info.plist`**
  (fix 7 needs it since `provideCredentialWithoutUserInteraction` can now legitimately trigger a
  prompt via `prepareInterfaceToProvideCredential`'s fallback). Verified via a fresh
  `npx expo prebuild --clean` on this machine: the generated `PasswordVault.xcodeproj`'s
  `INFOPLIST_FILE` build setting for the credentials-provider target points straight at
  `../targets/credentials-provider/Info.plist` — i.e. `@bacons/apple-targets` uses the checked-in
  file as-is, it does not regenerate/overwrite its contents. No further action needed here.
- **Vault-file writes on iOS now go through a new native function**,
  `SharedVaultStore.writeVaultFileCoordinated`, instead of a plain `File.write()` — this makes
  the main app's saves participate in the same `NSFileCoordinator` protocol the extension already
  uses for its reads/writes, closing a rollback window between the two processes. No new
  entitlement or capability is needed for this (it's the same App Group container, just a
  coordinated write instead of an uncoordinated one) — but it IS new native code in
  `modules/shared-vault-store/ios/SharedVaultStoreModule.swift`, so it needs the same "does the
  local Expo Module autolink and compile" verification already called out below as unverified.
- **A new `VaultStatus === "error"` screen** appears if, on iOS, the App Group container can't be
  resolved at all (previously this silently fell back to a stale private copy). If you ever see
  "Vault unavailable — Vault storage is misconfigured — reinstall the app" on your phone, it
  means the App Group entitlement/capability isn't wired up correctly for that build — recheck
  step 5 above (both targets need the same App Group selected and registered).
- **Disabling Face ID unlock in the app now fully unwinds AutoFill access**: it deletes the
  shared Keychain Vault Key, clears the local master-password credential, AND wipes
  `ASCredentialIdentityStore` (so the QuickType bar stops suggesting hostnames for a vault the
  extension can no longer decrypt) — in that order, and it now surfaces an error instead of
  silently marking biometrics disabled if the Keychain delete actually fails. No Xcode action
  needed, but worth testing once you're on a device: toggle Face ID unlock off, then check
  Settings → Passwords that Password Vault's QuickType suggestions are gone.
- **`ASCredentialIdentityStore` sync now only runs while biometrics/AutoFill are enabled** (it
  previously ran on every unlock regardless of opt-in) — no Xcode action needed.

None of the above required new entitlements, new SPM packages, or new Info.plist extension
points beyond the one `NSFaceIDUsageDescription` key called out above.

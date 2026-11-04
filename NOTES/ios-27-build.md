# Building the mobile app on Xcode 27 / iOS 27 (4-Nov-2026)

First real build of `apps/mobile`. Four things stood between "code exists" and "app launches";
all are now reproducible from `npm run prebuild:ios --workspace @pw/mobile` (never plain
`expo prebuild`, which leaves them unfixed). `ios/` is generated and gitignored.

1. **iOS 27 SDK apps must adopt the UIScene life cycle** or UIKit traps at launch
   ("UIScene life cycle is required"). Expo 57.0.4 had no support; **expo >= 57.0.31 ships
   `ExpoAppSceneDelegate`**, but its prebuild template still doesn't use it.
   `plugins/withSceneLifecycle.js` adds the scene manifest and makes `AppDelegate` an
   `ExpoReactNativeFactoryProvider`. It throws if the template changes shape; delete it once the
   template adopts scenes itself. This is why Expo + RN were bumped to the SDK-57 patch set.
2. **swift-sodium must be linked into the AutoFill extension** (was a manual Xcode step).
   `scripts/ios-postprebuild.rb` adds the package reference and links `Sodium`.
3. **swift-sodium has two `encrypt` overloads** (combined bytes vs. a `(ciphertext, nonce)`
   tuple). `VaultAccess.swift` annotates the tuple type to pick one.
4. **The repo path contains a space.** Expo's `get-app-config-ios.sh` phase and RN's bundle phase
   don't quote it, so the build dies with `bash: .../Documents/Password: No such file`. The
   post-prebuild script quotes both (and patches the Podfile for later `pod install`s). Renaming
   the folder would remove the cause. The same script turns off
   `ENABLE_USER_SCRIPT_SANDBOXING`, which blocks CocoaPods phases from writing into `Pods/`.

Dev loop: `preview_start metro` (or `cd apps/mobile && npx expo start --dev-client`), then build
and launch. Debug builds fetch JS from Metro, so a white screen means Metro isn't running or is
serving stale code after a dependency change. Metro must start from `apps/mobile`, or it
generates a stray root `tsconfig.json`.

Not yet verified: anything past the "Create your vault" screen, the AutoFill extension at
runtime, and a build on the physical iPhone.

// iOS 27 SDK apps crash at launch ("UIScene life cycle is required") unless they adopt the
// scene-based life cycle. expo 57.0.31 ships ExpoAppSceneDelegate for this but the prebuild
// template does not use it yet, so wire it up here. Drop this plugin once the template does.
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const SCENE_DELEGATE_CLASS = "EXExpoAppSceneDelegate";

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return cfg;
  });
}

// The scene delegate creates the window and starts React Native, so the app delegate must stop
// doing that itself and instead expose its factory through ExpoReactNativeFactoryProvider.
function withProviderAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("ExpoReactNativeFactoryProvider")) return cfg;

    const startBlock =
      /#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*factory\.startReactNative\(\s*withModuleName: "main",\s*in: window,\s*launchOptions: launchOptions\)\s*#endif\n/;
    const classDecl = "class AppDelegate: ExpoAppDelegate {";
    if (!startBlock.test(src) || !src.includes(classDecl)) {
      throw new Error(
        "withSceneLifecycle: AppDelegate.swift no longer matches the expected Expo template; " +
          "check whether the template adopts UIScene itself and remove this plugin."
      );
    }
    src = src
      .replace(classDecl, "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {")
      .replace(startBlock, "    // Window creation and startReactNative happen in ExpoAppSceneDelegate.\n");
    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = (config) => withProviderAppDelegate(withSceneManifest(config));

// Metro config for the npm-workspaces monorepo: watch the workspace root so
// @pw/core (symlinked into root node_modules) is bundled from source, and
// resolve modules from both the app's and the root node_modules.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// @pw/core's initCrypto() has a web/Node fallback `import("libsodium-wrappers-sumo")`.
// Mobile always injects react-native-libsodium instead (src/sodiumProvider.ts), but Metro
// still bundles the fallback import statically and the package's ESM internals don't
// resolve under Metro — so route it to a throwing shim.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "libsodium-wrappers-sumo") {
    return {
      type: "sourceFile",
      filePath: path.resolve(projectRoot, "shims/libsodium-wrappers-sumo.js"),
    };
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

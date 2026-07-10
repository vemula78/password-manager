// Metro shim. @pw/core's initCrypto() contains a fallback `import("libsodium-wrappers-sumo")`
// for web/Node; Metro bundles that import statically and the package's ESM internals don't
// resolve under Metro. On mobile the sodium instance is ALWAYS injected up front
// (src/sodiumProvider.ts → initCrypto(adapter)), so the fallback path can never run —
// this shim satisfies the resolver and throws loudly if it is ever actually used.
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "libsodium-wrappers-sumo is not available in the mobile app. " +
          "Call initSodium() from src/sodiumProvider.ts before any crypto use.",
      );
    },
  },
);

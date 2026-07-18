// The `credentials-provider` target type is NOT in @bacons/apple-targets' appGroupsByDefault
// auto-sync list (that's widget/share/clip/bg-download only), so both entitlements this
// extension needs must be repeated explicitly here — they don't inherit from app.json.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "credentials-provider",
  deploymentTarget: "16.0",
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
    "com.apple.developer.authentication-services.autofill-credential-provider": true,
  },
});
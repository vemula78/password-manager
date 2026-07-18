Pod::Spec.new do |s|
  s.name           = 'SharedVaultStore'
  s.version        = '1.0.0'
  s.summary        = 'Shared App Group container path + Keychain access for the AutoFill credential provider extension'
  s.description    = 'Local Expo Module exposing the App Group shared container path, a Face ID/passcode-gated shared Keychain item for the Vault Key, and ASCredentialIdentityStore sync — used to make the vault visible to the credentials-provider extension.'
  s.author         = 'Praveen Vemula'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.0',
    :tvos => '16.0'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

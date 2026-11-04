#!/usr/bin/env ruby
# Run after `expo prebuild` (see the "prebuild:ios" npm script). ios/ is generated and gitignored,
# so every fix the generated project needs lives here, idempotently:
#   1. Link swift-sodium's `Sodium` into the AutoFill extension (no declarative way in
#      @bacons/apple-targets; NOTES/ios-autofill-setup.md step 3).
#   2. Quote paths in two Expo/RN script phases that break when the repo path has a space
#      ("Password Manager").
#   3. Turn off user-script sandboxing; CocoaPods script phases write into Pods/.
require "xcodeproj"

IOS = File.expand_path("../ios", __dir__)

app = Xcodeproj::Project.open(File.join(IOS, "PasswordVault.xcodeproj"))

# 1. Sodium -> credentialsprovider
ext = app.targets.find { |t| t.name == "credentialsprovider" } or abort "credentialsprovider target not found"
unless ext.package_product_dependencies.any? { |d| d.product_name == "Sodium" }
  pkg = app.root_object.package_references.find { |r| r.repositoryURL =~ /swift-sodium/ }
  unless pkg
    pkg = app.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
    pkg.repositoryURL = "https://github.com/jedisct1/swift-sodium"
    pkg.requirement = { "kind" => "upToNextMajorVersion", "minimumVersion" => "0.11.0" }
    app.root_object.package_references << pkg
  end
  dep = app.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dep.product_name = "Sodium"
  dep.package = pkg
  ext.package_product_dependencies << dep
  bf = app.new(Xcodeproj::Project::Object::PBXBuildFile)
  bf.product_ref = dep
  ext.frameworks_build_phase.files << bf
end

# 2a. App's "Bundle React Native code and images": unquoted `...` command substitution.
main = app.targets.find { |t| t.name == "PasswordVault" } or abort "PasswordVault target not found"
bundle = main.shell_script_build_phases.find { |p| p.name == "Bundle React Native code and images" } or abort "bundle phase not found"
lines = bundle.shell_script.lines
i = lines.rindex { |l| l.start_with?("`\"$NODE_BINARY\"") }
if i
  inner = lines[i].strip.delete_prefix("`").delete_suffix("`")
  lines[i] = "\"$(#{inner})\"\n"
  bundle.shell_script = lines.join
end

# 3. Script sandboxing off.
app.build_configurations.each { |c| c.build_settings["ENABLE_USER_SCRIPT_SANDBOXING"] = "NO" }
app.save

# 2b. expo-constants' get-app-config-ios.sh invocation in the Pods project, and in the Podfile so a
# later plain `pod install` keeps the fix.
bad = 'bash -l -c "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"'
good = 'bash -l -c "\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\""'
pods = Xcodeproj::Project.open(File.join(IOS, "Pods", "Pods.xcodeproj"))
pods.targets.each do |t|
  t.shell_script_build_phases.each do |ph|
    ph.shell_script = ph.shell_script.gsub(bad, good) if ph.shell_script.include?(bad)
  end
end
pods.save

podfile = File.join(IOS, "Podfile")
src = File.read(podfile)
unless src.include?("get-app-config-ios.sh")
  hook = <<~RUBY.gsub(/^/, "    ")

    # expo-constants runs `bash -l -c "$PODS_TARGET_SRCROOT/..."` unquoted; breaks on a space in the repo path.
    installer.pods_project.targets.each do |t|
      t.shell_script_build_phases.each do |ph|
        next unless ph.shell_script.include?('get-app-config-ios.sh')
        ph.shell_script = ph.shell_script.gsub(
          'bash -l -c "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"',
          'bash -l -c "\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\""'
        )
      end
    end
  RUBY
  patched = src.sub(/(      :ccache_enabled => ccache_enabled\?\(podfile_properties\),\n    \)\n)/) { "#{$1}#{hook}" }
  abort "Podfile post_install anchor not found" if patched == src
  File.write(podfile, patched)
end

puts "ios-postprebuild: ok"

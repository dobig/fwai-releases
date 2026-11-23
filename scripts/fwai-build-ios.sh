#!/usr/bin/env bash
# Build the production iOS app against prod (deploy/stages/prod.env) and upload it
# to App Store Connect for TestFlight.
#
#   ASC_KEY_ID=... ASC_ISSUER_ID=... scripts/fwai-build-ios.sh
#
# Signing goes through an App Store Connect API key (Admin, team key) at
# ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (or ASC_KEY_PATH):
# xcodebuild registers the App Group and profiles, archives with development
# signing and re-signs for distribution on export. The bundle ids and the app
# record (Apple ID in apps/mobile/eas.json) must already exist.
# Only production exists for now: preview/staging would need their own app record.
set -euo pipefail

: "${ASC_KEY_ID:?set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
key_path="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[ -f "$key_path" ] || { echo "no API key at $key_path" >&2; exit 1; }
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key_path"
      -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

# Archives sign with an Apple Development identity. Over SSH or in the Actions
# runner the login keychain is locked, so the identity lives in its own keychain,
# named with its password in $FWAI_SIGNING_DIR/ios/keychain.env
# (FWAI_IOS_KEYCHAIN, FWAI_IOS_KEYCHAIN_PASSWORD); without that file the
# default keychains are used.
keychain_env="${FWAI_SIGNING_DIR:-$HOME/.fwai-signing}/ios/keychain.env"
if [ -f "$keychain_env" ]; then
  # shellcheck disable=SC1090
  . "$keychain_env"
  security unlock-keychain -p "$FWAI_IOS_KEYCHAIN_PASSWORD" "$FWAI_IOS_KEYCHAIN"
  # Electron builds swap the search list for temporary keychains; put ours back.
  keychains=()
  while IFS= read -r line; do
    line="${line//\"/}"
    line="${line#"${line%%[![:space:]]*}"}"
    [ -n "$line" ] && [ "$line" != "$FWAI_IOS_KEYCHAIN" ] && keychains+=("$line")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$FWAI_IOS_KEYCHAIN" "${keychains[@]}"
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"
. scripts/lib/fwai-stage.sh
fwai_load_stage prod
export APP_VARIANT=production EXPO_NO_GIT_STATUS=1
team_id="${T3CODE_FWAI_IOS_TEAM_ID:-3MYY669SXY}"

# Upload time as build number: App Store Connect rejects a number it has seen.
build="${FWAI_IOS_BUILD_NUMBER:-$(date -u +%y%m%d%H%M)}"
out="${FWAI_IOS_OUT:-$root/apps/mobile/build/testflight}"
rm -rf "$out"
mkdir -p "$out"

echo "==> iOS prod build $build (gateway $T3CODE_FWAI_GATEWAY_URL, relay $T3CODE_RELAY_URL)"
cd apps/mobile
pnpm exec expo prebuild --clean --platform ios
# Prebuild writes CFBundleVersion 1 into the app and widget plists, which would
# make every upload after the first a duplicate; extensions must match the app.
for plist in ios/*/Info.plist; do
  if /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$plist" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build" "$plist"
  fi
done

xcodebuild archive -workspace ios/fwai.xcworkspace -scheme fwai -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$out/fwai.xcarchive" \
  DEVELOPMENT_TEAM="$team_id" CURRENT_PROJECT_VERSION="$build" "${auth[@]}"

cat >"$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${team_id}</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$out/fwai.xcarchive" \
  -exportOptionsPlist "$out/ExportOptions.plist" -exportPath "$out/export" "${auth[@]}"
echo "==> uploaded build $build; it shows in TestFlight once App Store Connect has processed it"

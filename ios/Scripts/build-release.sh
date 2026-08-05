#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${SNAPLIST_IOS_REPOSITORY_ROOT:-${script_directory:h:h}}
snaplist_developer_dir=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
snaplist_derived_data=${SNAPLIST_IOS_RELEASE_DERIVED_DATA:-${TMPDIR:-/tmp}/snaplist-ios-release-derived-data}
app_path=${snaplist_derived_data}/Build/Products/Release-iphonesimulator/SnapList.app

export DEVELOPER_DIR=$snaplist_developer_dir

"${script_directory}/release-config-lint.sh"

cd "$repository_root"

xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -configuration Release \
  -sdk iphonesimulator \
  -derivedDataPath "$snaplist_derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY="$SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY" \
  SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN="$SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN" \
  build

if [[ ! -d $app_path ]]; then
  print -u2 -r -- "Release app was not built at expected path: $app_path"
  exit 1
fi

[[ $(/usr/libexec/PlistBuddy -c 'Print :SnapListClerkPublishableKey' "$app_path/Info.plist") == "$SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY" ]]
[[ $(/usr/libexec/PlistBuddy -c 'Print :SnapListClerkPublishableKey' "$app_path/Info.plist") == pk_live_* ]]

if /usr/bin/strings "$app_path/SnapList" | /usr/bin/grep -Fq -- '--fixture='; then
  print -u2 -r -- "Release binary contains fixture launch-argument handling."
  exit 1
fi

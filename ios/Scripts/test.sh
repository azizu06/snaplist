#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
snaplist_developer_dir=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
snaplist_destination=${SNAPLIST_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=latest}
snaplist_derived_data=${SNAPLIST_IOS_DERIVED_DATA:-${TMPDIR:-/tmp}/snaplist-ios-derived-data}

export DEVELOPER_DIR=$snaplist_developer_dir

cd $repository_root

xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -destination $snaplist_destination \
  -derivedDataPath $snaplist_derived_data \
  test

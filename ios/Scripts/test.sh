#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${SNAPLIST_IOS_REPOSITORY_ROOT:-${script_directory:h:h}}
snaplist_developer_dir=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
snaplist_destination=${SNAPLIST_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=latest}
snaplist_derived_data=${SNAPLIST_IOS_DERIVED_DATA:-${TMPDIR:-/tmp}/snaplist-ios-derived-data}
snaplist_test_selector_pattern='^[[:alnum:]_][[:alnum:]_.-]*(/[[:alnum:]_][[:alnum:]_.-]*){0,2}$'
typeset -a snaplist_focused_test_argument=()

export DEVELOPER_DIR=$snaplist_developer_dir

cd "$repository_root"

if (( ${+SNAPLIST_IOS_ONLY_TESTING} )); then
  if [[ ! $SNAPLIST_IOS_ONLY_TESTING =~ $snaplist_test_selector_pattern ]]; then
    print -u2 -r -- \
      "SNAPLIST_IOS_ONLY_TESTING must be a non-empty Xcode test selector."
    exit 64
  fi

  snaplist_focused_test_argument=("-only-testing:${SNAPLIST_IOS_ONLY_TESTING}")
fi

xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -destination $snaplist_destination \
  -derivedDataPath $snaplist_derived_data \
  "${snaplist_focused_test_argument[@]}" \
  test

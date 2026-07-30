#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${SNAPLIST_IOS_REPOSITORY_ROOT:-${script_directory:h:h}}
snaplist_developer_dir=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
snaplist_destination=${SNAPLIST_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=latest}
snaplist_derived_data=${SNAPLIST_IOS_DERIVED_DATA:-${TMPDIR:-/tmp}/snaplist-ios-derived-data}
snaplist_test_selector_pattern='^[[:alnum:]_][[:alnum:]_.-]*(/[[:alnum:]_][[:alnum:]_.-]*){0,2}$'
snaplist_shard_inventory=${script_directory}/test-shards.json
snaplist_shard_validator=${script_directory}/validate-test-shards.rb
typeset -a snaplist_test_arguments=()
typeset -a snaplist_shard_selectors=()

export DEVELOPER_DIR=$snaplist_developer_dir

cd "$repository_root"

if (( ${+SNAPLIST_IOS_ONLY_TESTING} && ${+SNAPLIST_IOS_SHARD} )); then
  print -u2 -r -- \
    "SNAPLIST_IOS_ONLY_TESTING and SNAPLIST_IOS_SHARD cannot be combined."
  exit 64
fi

if (( ${+SNAPLIST_IOS_ONLY_TESTING} )); then
  if [[ ! $SNAPLIST_IOS_ONLY_TESTING =~ $snaplist_test_selector_pattern ]]; then
    print -u2 -r -- \
      "SNAPLIST_IOS_ONLY_TESTING must be a non-empty Xcode test selector."
    exit 64
  fi

  snaplist_test_arguments=("-only-testing:${SNAPLIST_IOS_ONLY_TESTING}")
fi

if (( ${+SNAPLIST_IOS_SHARD} )); then
  case $SNAPLIST_IOS_SHARD in
    unit | ui-1 | ui-2) ;;
    *)
      print -u2 -r -- "SNAPLIST_IOS_SHARD must be unit, ui-1, or ui-2."
      exit 64
      ;;
  esac

  "$snaplist_shard_validator" "$snaplist_shard_inventory"
  snaplist_shard_selectors=(
    "${(@f)$(ruby -rjson -e '
      inventory = JSON.parse(File.read(ARGV.fetch(0)))
      puts inventory.fetch("shards").fetch(ARGV.fetch(1))
    ' "$snaplist_shard_inventory" "$SNAPLIST_IOS_SHARD")}"
  )

  for snaplist_shard_selector in "${snaplist_shard_selectors[@]}"; do
    snaplist_test_arguments+=("-only-testing:${snaplist_shard_selector}")
  done
fi

xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -destination $snaplist_destination \
  -derivedDataPath $snaplist_derived_data \
  "${snaplist_test_arguments[@]}" \
  test

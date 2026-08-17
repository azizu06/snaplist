#!/bin/zsh

set -euo pipefail

zmodload zsh/system

script_directory=${0:A:h}
repository_root=${SNAPLIST_IOS_REPOSITORY_ROOT:-${script_directory:h:h}}
snaplist_developer_dir=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
snaplist_destination=${SNAPLIST_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=latest}
snaplist_derived_data=${SNAPLIST_IOS_DERIVED_DATA:-${TMPDIR:-/tmp}/snaplist-ios-derived-data}
snaplist_test_selector_pattern='^[[:alnum:]_][[:alnum:]_.-]*(/[[:alnum:]_][[:alnum:]_.-]*){0,2}$'
snaplist_shard_inventory=${script_directory}/test-shards.json
snaplist_shard_validator=${script_directory}/validate-test-shards.rb
snaplist_lock_file=${SNAPLIST_IOS_LOCK_FILE:-${TMPDIR:-/tmp}/snaplist-ios-xcodebuild.lock}
snaplist_lock_owner_file=${snaplist_lock_file}.owner
snaplist_lock_poll_seconds=${SNAPLIST_IOS_LOCK_POLL_SECONDS:-15}
snaplist_lock_timeout_seconds=${SNAPLIST_IOS_LOCK_TIMEOUT_SECONDS:-7200}
snaplist_lock_descriptor=
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
  "$snaplist_shard_validator" "$snaplist_shard_inventory"

  if ! ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    exit inventory.fetch("shards").key?(ARGV.fetch(1)) ? 0 : 1
  ' "$snaplist_shard_inventory" "$SNAPLIST_IOS_SHARD"; then
    print -u2 -r -- "SNAPLIST_IOS_SHARD is not declared in the shard inventory."
    exit 64
  fi

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

snaplist_release_build_lock() {
  if [[ -n $snaplist_lock_descriptor ]]; then
    rm -f "$snaplist_lock_owner_file"
    zsystem flock -u "$snaplist_lock_descriptor"
    snaplist_lock_descriptor=
  fi
}

snaplist_release_build_lock_after_signal() {
  snaplist_release_build_lock
  exit $(( 128 + $1 ))
}

# EXIT alone does not cover the way these runs actually end. zsh does not run
# TRAPEXIT when an untrapped SIGTERM kills the shell, and an agent that has
# decided a build is hung sends exactly that. Without these the owner file
# outlives the run and the next waiter reads out a pid that is already gone,
# which is the one diagnostic the waiter exists to provide.
trap snaplist_release_build_lock EXIT
trap 'snaplist_release_build_lock_after_signal 1' HUP
trap 'snaplist_release_build_lock_after_signal 2' INT
trap 'snaplist_release_build_lock_after_signal 15' TERM

if (( ${#snaplist_test_arguments} )); then
  snaplist_lock_scope=${(j: :)snaplist_test_arguments}
else
  snaplist_lock_scope="the complete test suite"
fi

: >> "$snaplist_lock_file"

if ! zsystem flock -t 0 -f snaplist_lock_descriptor "$snaplist_lock_file" 2>/dev/null; then
  snaplist_lock_holder="held by an iOS build that has not recorded itself yet"

  if [[ -s $snaplist_lock_owner_file ]]; then
    snaplist_lock_holder=$(<"$snaplist_lock_owner_file")
  fi

  snaplist_lock_wait_started=$SECONDS

  print -u2 -r -- \
    "Waiting for the iOS build lock at ${snaplist_lock_file}; ${snaplist_lock_holder}; waited 0s."

  while ! zsystem flock \
    -t "$snaplist_lock_poll_seconds" \
    -f snaplist_lock_descriptor \
    "$snaplist_lock_file" 2>/dev/null
  do
    snaplist_lock_waited=$(( SECONDS - snaplist_lock_wait_started ))

    if (( snaplist_lock_waited >= snaplist_lock_timeout_seconds )); then
      print -u2 -r -- \
        "Gave up on the iOS build lock at ${snaplist_lock_file} after ${snaplist_lock_waited}s; ${snaplist_lock_holder}."
      exit 75
    fi

    if [[ -s $snaplist_lock_owner_file ]]; then
      snaplist_lock_holder=$(<"$snaplist_lock_owner_file")
    fi

    print -u2 -r -- \
      "Waiting for the iOS build lock at ${snaplist_lock_file}; ${snaplist_lock_holder}; waited ${snaplist_lock_waited}s."
  done

  print -u2 -r -- \
    "Acquired the iOS build lock after $(( SECONDS - snaplist_lock_wait_started ))s."
fi

print -r -- \
  "held by pid $$ in ${repository_root} running ${snaplist_lock_scope} since $(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  > "$snaplist_lock_owner_file"

xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -destination $snaplist_destination \
  -derivedDataPath $snaplist_derived_data \
  "${snaplist_test_arguments[@]}" \
  test {snaplist_lock_descriptor}<&-

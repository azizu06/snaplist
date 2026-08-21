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
# The one place the shard wall-clock budget is stated. It is issue #936's
# acceptance criterion, not the job cap: a shard is supposed to finish inside
# it, and the job-level `timeout-minutes` in .github/workflows/ios.yml sits
# above it with room to spare.
snaplist_shard_budget_file=${SNAPLIST_IOS_SHARD_BUDGET_FILE:-${script_directory}/shard-wall-clock-budget-minutes}
# Passing the budget breaks the acceptance criterion; it does not break the
# build. A slow runner that lands at 31 minutes should say so and finish, not
# go red. So the budget annotates and this margin above it is what kills, still
# below the job cap so GitHub never gets to cancel the job with nothing but
# "The operation was canceled."
snaplist_shard_kill_margin_minutes=${SNAPLIST_IOS_SHARD_KILL_MARGIN_MINUTES:-2}
snaplist_shard_timeout_poll_seconds=${SNAPLIST_IOS_SHARD_TIMEOUT_POLL_SECONDS:-5}
snaplist_shard_timeout_kill_grace_seconds=${SNAPLIST_IOS_SHARD_TIMEOUT_KILL_GRACE_SECONDS:-5}
snaplist_xcodebuild_pid=0
snaplist_lock_file=${SNAPLIST_IOS_LOCK_FILE:-${TMPDIR:-/tmp}/snaplist-ios-xcodebuild.lock}
snaplist_lock_owner_file=${snaplist_lock_file}.owner
snaplist_lock_poll_seconds=${SNAPLIST_IOS_LOCK_POLL_SECONDS:-15}
snaplist_lock_timeout_seconds=${SNAPLIST_IOS_LOCK_TIMEOUT_SECONDS:-7200}
snaplist_lock_owner_grace_seconds=${SNAPLIST_IOS_LOCK_OWNER_GRACE_SECONDS:-2}
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

# The wall-clock budget only applies to a declared shard. `serial`, `focused`
# and every local invocation reach this with SNAPLIST_IOS_SHARD unset and run
# with no budget at all, which is why backgrounding xcodebuild below has to
# leave their behaviour intact.
snaplist_shard_warn_seconds=0
snaplist_shard_kill_seconds=0
if (( ${+SNAPLIST_IOS_SHARD} )); then
  snaplist_shard_budget_minutes=$(<"$snaplist_shard_budget_file")
  snaplist_shard_warn_seconds=${SNAPLIST_IOS_SHARD_WARN_SECONDS:-$(( \
    snaplist_shard_budget_minutes * 60 \
  ))}
  snaplist_shard_kill_seconds=${SNAPLIST_IOS_SHARD_KILL_SECONDS:-$(( \
    (snaplist_shard_budget_minutes + snaplist_shard_kill_margin_minutes) * 60 \
  ))}
fi

# Reading the derivation out is the only way a test can assert it without
# either overriding the thresholds it wants to check or waiting out a real
# thirty minute budget.
if [[ ${1-} == --print-shard-wall-clock-plan ]]; then
  print -r -- "warn=${snaplist_shard_warn_seconds} kill=${snaplist_shard_kill_seconds}"
  exit 0
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

# The holder records itself in the sidecar file immediately after it takes the
# flock, but "immediately after" is still after. A waiter that started in the
# same instant loses that race and would otherwise announce an anonymous lock
# and then say nothing else for a whole poll interval, which is precisely the
# moment two agents collide and precisely when the name is worth having. So
# give the sidecar a bounded grace to appear before falling back.
snaplist_read_lock_holder() {
  local deadline=$(( SECONDS + $1 ))

  while :; do
    if [[ -s $snaplist_lock_owner_file ]]; then
      print -r -- "$(<"$snaplist_lock_owner_file")"
      return 0
    fi

    (( SECONDS >= deadline )) && break

    sleep 0.05
  done

  print -r -- "held by an iOS build that has not recorded itself yet"
}

# xcodebuild is a parent, not a leaf. It runs xctest, which drives a booted
# simulator, so signalling the direct child leaves the processes that actually
# hold the simulator and DerivedData behind. The launch below puts xcodebuild
# in its own process group precisely so the negative pid here reaches all of
# them.
snaplist_terminate_xcodebuild() {
  local grace_deadline

  (( snaplist_xcodebuild_pid )) || return 0

  kill -TERM -- -$snaplist_xcodebuild_pid 2>/dev/null || true

  # Poll the grace out instead of sleeping through it. SIGTERM usually lands
  # at once, and burning the full grace every time is time the budget this
  # script exists to defend has already spent.
  grace_deadline=$(( SECONDS + snaplist_shard_timeout_kill_grace_seconds ))

  while kill -0 $snaplist_xcodebuild_pid 2>/dev/null; do
    (( SECONDS >= grace_deadline )) && break

    sleep 0.1
  done

  kill -KILL -- -$snaplist_xcodebuild_pid 2>/dev/null || true
  wait $snaplist_xcodebuild_pid 2>/dev/null || true
  snaplist_xcodebuild_pid=0
}

snaplist_release_build_lock() {
  if [[ -n $snaplist_lock_descriptor ]]; then
    rm -f "$snaplist_lock_owner_file"
    zsystem flock -u "$snaplist_lock_descriptor"
    snaplist_lock_descriptor=
  fi
}

# The lock is a claim about a running build, so it cannot be given up while
# that build is still running. A foreground child defers trap delivery until it
# exits and this ordering never came up; a backgrounded one delivers the signal
# straight into an interruptible `wait`, so without the reap this handler would
# report the lock free with xcodebuild still alive and orphaned. The next
# invocation in another worktree would then take the flock and start a second
# build against the same simulator and DerivedData.
snaplist_release_build_lock_after_signal() {
  snaplist_terminate_xcodebuild
  snaplist_release_build_lock
  exit $(( 128 + $1 ))
}

snaplist_release_build_lock_on_exit() {
  snaplist_terminate_xcodebuild
  snaplist_release_build_lock
}

# EXIT alone does not cover the way these runs actually end. zsh does not run
# TRAPEXIT when an untrapped SIGTERM kills the shell, and an agent that has
# decided a build is hung sends exactly that. Without these the owner file
# outlives the run and the next waiter reads out a pid that is already gone,
# which is the one diagnostic the waiter exists to provide.
trap snaplist_release_build_lock_on_exit EXIT
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
  snaplist_lock_wait_started=$SECONDS
  snaplist_lock_holder=$(
    snaplist_read_lock_holder "$snaplist_lock_owner_grace_seconds"
  )

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

    snaplist_lock_holder=$(snaplist_read_lock_holder 0)

    print -u2 -r -- \
      "Waiting for the iOS build lock at ${snaplist_lock_file}; ${snaplist_lock_holder}; waited ${snaplist_lock_waited}s."
  done

  print -u2 -r -- \
    "Acquired the iOS build lock after $(( SECONDS - snaplist_lock_wait_started ))s."
fi

print -r -- \
  "held by pid $$ in ${repository_root} running ${snaplist_lock_scope} since $(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  > "$snaplist_lock_owner_file"

# `setpgrp` then `exec` makes xcodebuild the leader of its own process group
# while keeping the pid, so `kill -0` and `wait` still work here and
# `snaplist_terminate_xcodebuild` can signal the whole tree. zsh's own `set -m`
# would do this, but it is unavailable without a controlling terminal, which is
# exactly the CI case.
xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -destination $snaplist_destination \
  -derivedDataPath $snaplist_derived_data \
  "${snaplist_test_arguments[@]}" \
  test {snaplist_lock_descriptor}<&- &
snaplist_xcodebuild_pid=$!

if (( snaplist_shard_kill_seconds <= 0 )); then
  wait $snaplist_xcodebuild_pid
  snaplist_xcodebuild_status=$?
  snaplist_xcodebuild_pid=0
  exit $snaplist_xcodebuild_status
fi

# Both deadlines are measured from the start of this script rather than from
# the moment xcodebuild launched, because the budget is a claim about the job's
# wall clock and a contended lock wait spends that clock too. In CI nothing
# contends, so this only bites the local case it should.
snaplist_shard_warn_deadline=$snaplist_shard_warn_seconds
snaplist_shard_kill_deadline=$snaplist_shard_kill_seconds
snaplist_shard_warned=0

while kill -0 $snaplist_xcodebuild_pid 2>/dev/null; do
  if (( ! snaplist_shard_warned && SECONDS >= snaplist_shard_warn_deadline )); then
    snaplist_shard_warned=1

    print -u2 -r -- \
      "::warning::iOS shard ${SNAPLIST_IOS_SHARD} passed its ${snaplist_shard_warn_seconds}s wall-clock budget and is still running; issue #936 asks for a shard that finishes inside that budget."
  fi

  if (( SECONDS >= snaplist_shard_kill_deadline )); then
    snaplist_terminate_xcodebuild

    print -u2 -r -- \
      "::error::iOS shard ${SNAPLIST_IOS_SHARD} exceeded its wall-clock budget of ${snaplist_shard_warn_seconds}s by more than the ${snaplist_shard_kill_margin_minutes} minute kill margin and was stopped by test.sh before the job's own timeout; no test failed."
    exit 124
  fi

  sleep $snaplist_shard_timeout_poll_seconds
done

wait $snaplist_xcodebuild_pid
snaplist_xcodebuild_status=$?
snaplist_xcodebuild_pid=0
exit $snaplist_xcodebuild_status

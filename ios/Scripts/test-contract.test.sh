#!/bin/zsh

set -u
set -o pipefail

script_directory=${0:A:h}
test_script=${script_directory}/test.sh
workflow_file=${script_directory:h:h}/.github/workflows/ios.yml
workflow_contract_parser=${script_directory}/validate-workflow-concurrency.rb
shard_inventory_file=${script_directory}/test-shards.json
shard_inventory_validator=${script_directory}/validate-test-shards.rb
shard_wall_clock_budget_file=${script_directory}/shard-wall-clock-budget-minutes
temporary_parent=${TMPDIR:-/tmp}
temporary_directory=$(mktemp -d "${temporary_parent%/}/snaplist-ios-test-contract.XXXXXX")
fake_bin=${temporary_directory}/bin
arguments_file=${temporary_directory}/xcodebuild-arguments
working_directory_file=${temporary_directory}/xcodebuild-working-directory
injection_marker=${temporary_directory}/selector-was-evaluated
target_repository=${temporary_directory}/target-repository
broken_workflow_file=${temporary_directory}/broken-ios.yml
formatted_workflow_file=${temporary_directory}/formatted-ios.yml
inactive_workflow_file=${temporary_directory}/inactive-ios.yml
sample_gaming_workflow_file=${temporary_directory}/sample-gaming-ios.yml
concrete_format_workflow_file=${temporary_directory}/concrete-format-ios.yml
job_override_workflow_file=${temporary_directory}/job-override-ios.yml
job_isolated_workflow_file=${temporary_directory}/job-isolated-ios.yml
job_shared_dispatch_workflow_file=${temporary_directory}/job-shared-dispatch-ios.yml
job_matrix_workflow_file=${temporary_directory}/job-matrix-ios.yml
job_typo_workflow_file=${temporary_directory}/job-typo-ios.yml
job_run_scoped_workflow_file=${temporary_directory}/job-run-scoped-ios.yml
omitted_shard_inventory_file=${temporary_directory}/omitted-test-shards.json
duplicated_shard_inventory_file=${temporary_directory}/duplicated-test-shards.json
empty_shard_inventory_file=${temporary_directory}/empty-test-shards.json
stale_timing_inventory_file=${temporary_directory}/stale-timing-test-shards.json
nested_test_repository=${temporary_directory}/nested-test-repository
lock_file=${temporary_directory}/xcodebuild.lock
serialized_bin=${temporary_directory}/serialized-bin
serialized_active_marker=${temporary_directory}/xcodebuild-active
serialized_overlap_log=${temporary_directory}/xcodebuild-overlap
serialized_started_log=${temporary_directory}/xcodebuild-started
holder_diagnostics_file=${temporary_directory}/holder-diagnostics
shard_timeout_diagnostics_file=${temporary_directory}/shard-timeout-diagnostics
serialized_descendant_log=${temporary_directory}/xcodebuild-descendants
substitute_shard_wall_clock_budget_file=${temporary_directory}/substitute-shard-wall-clock-budget-minutes
waiter_diagnostics_file=${temporary_directory}/waiter-diagnostics
holder_selector="SnapListTests/LockHolderProbeTests/testHoldsTheBuildLock"

mkdir -p "$fake_bin" "$target_repository" "$serialized_bin"

cat > "${serialized_bin}/xcodebuild" <<'EOF'
#!/bin/zsh

# The real xcodebuild is a parent, not a leaf: it runs xctest, which drives a
# booted simulator. Signalling only the direct child leaves those behind. So
# this stand-in sleeps in a descendant and records it, which is the only way a
# test can tell "the child died" from "the process tree died".
snaplist_sleep_in_a_descendant() {
  sleep "$SNAPLIST_XCODEBUILD_SLEEP_SECONDS" &
  print -r -- "$!" >> "${SNAPLIST_XCODEBUILD_DESCENDANT_LOG:-/dev/null}"
  wait $!
}

if mkdir "$SNAPLIST_XCODEBUILD_ACTIVE_MARKER" 2>/dev/null; then
  print -r -- "$$" >> "$SNAPLIST_XCODEBUILD_STARTED_LOG"
  snaplist_sleep_in_a_descendant
  rmdir "$SNAPLIST_XCODEBUILD_ACTIVE_MARKER"
else
  print -r -- "$$" >> "$SNAPLIST_XCODEBUILD_OVERLAP_LOG"
  print -r -- "$$" >> "$SNAPLIST_XCODEBUILD_STARTED_LOG"
  snaplist_sleep_in_a_descendant
fi

exit "${SNAPLIST_XCODEBUILD_EXIT_STATUS:-0}"
EOF

chmod +x "${serialized_bin}/xcodebuild"

cat > "${fake_bin}/xcodebuild" <<'EOF'
#!/bin/zsh

print -r -- "$PWD" > "$SNAPLIST_XCODEBUILD_WORKING_DIRECTORY"

for argument in "$@"; do
  print -r -- "$argument" >> "$SNAPLIST_XCODEBUILD_ARGUMENTS"
done
EOF

chmod +x "${fake_bin}/xcodebuild"

cleanup() {
  rm -rf "$temporary_directory"
}

trap cleanup EXIT

run_test_script() {
  local selector_mode=$1
  local selector=${2-}
  local repository_root=${3-}
  local shard=${4-}

  (
    export PATH="${fake_bin}:${PATH}"
    export SNAPLIST_XCODEBUILD_ARGUMENTS=$arguments_file
    export SNAPLIST_XCODEBUILD_WORKING_DIRECTORY=$working_directory_file
    export SNAPLIST_IOS_LOCK_FILE=$lock_file

    if [[ $selector_mode == "set" ]]; then
      export SNAPLIST_IOS_ONLY_TESTING=$selector
    else
      unset SNAPLIST_IOS_ONLY_TESTING
    fi

    if [[ -n $repository_root ]]; then
      export SNAPLIST_IOS_REPOSITORY_ROOT=$repository_root
    else
      unset SNAPLIST_IOS_REPOSITORY_ROOT
    fi

    if [[ -n $shard ]]; then
      export SNAPLIST_IOS_SHARD=$shard
    else
      unset SNAPLIST_IOS_SHARD
    fi

    "$test_script"
  )
}

assert_default_runs_the_full_suite() {
  : > "$arguments_file"

  if ! run_test_script unset; then
    return 1
  fi

  if grep -q -- '^-only-testing:' "$arguments_file"; then
    return 1
  fi

  grep -Fxq -- "test" "$arguments_file"
}

assert_workflow_parallelizes_pr_shards_and_retains_main_serial_confidence() {
  ruby -rjson -ryaml -e '
    workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
    inventory = JSON.parse(File.read(ARGV.fetch(1)))
    jobs = workflow.fetch("jobs")
    workflow_environment = workflow.fetch("env")
    expected_shards = ["unit"] +
      (1..inventory.fetch("ui_shard_count")).map { |index| "ui-#{index}" }

    abort "Xcode toolchain must be pinned" unless
      workflow_environment.fetch("DEVELOPER_DIR") ==
        "/Applications/Xcode_26.5.app/Contents/Developer"
    abort "simulator runtime must be pinned" unless
      workflow_environment.fetch("SNAPLIST_IOS_DESTINATION") ==
        "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5"

    validate_job = jobs.fetch("validate")
    abort "PR/main validation guard changed" unless
      validate_job.fetch("if") ==
        "github.event_name == '\''pull_request'\'' || github.event_name == '\''push'\''"
    abort "PR validation must use the declared Apple runner" unless
      validate_job.fetch("runs-on") == "macos-26"
    validate_checkout_step = validate_job.fetch("steps").find do |step|
      step["uses"] == "actions/checkout@v4"
    end
    abort "validation must check out the exact candidate head on pull_request and the pushed commit on push" unless
      validate_checkout_step&.fetch("with")&.fetch("ref") ==
        "${{ github.event_name == '\''pull_request'\'' && github.event.pull_request.head.sha || github.sha }}"

    shard_job = jobs.fetch("shard")
    abort "PR shard guard changed" unless
      shard_job.fetch("if") == "github.event_name == '\''pull_request'\''"
    abort "PR shards must wait for validation" unless
      shard_job.fetch("needs") == "validate"
    abort "PR shards must use the declared Apple runner" unless
      shard_job.fetch("runs-on") == "macos-26"
    abort "all shard failures must remain visible" unless
      shard_job.fetch("strategy").fetch("fail-fast") == false
    abort "automatic suite must match the manifest-declared deterministic shards" unless
      shard_job.fetch("strategy").fetch("matrix").fetch("shard") ==
        expected_shards

    checkout_step = shard_job.fetch("steps").find do |step|
      step["uses"] == "actions/checkout@v4"
    end
    abort "PR shards must check out the exact candidate head" unless
      checkout_step&.fetch("with")&.fetch("ref") ==
        "${{ github.event.pull_request.head.sha }}"

    shard_step = shard_job.fetch("steps").find do |step|
      step["name"] == "Build app and run declared test shard"
    end
    abort "PR shard command changed" unless
      shard_step&.fetch("run") == "ios/Scripts/test.sh"
    abort "PR shard selector must come from the closed matrix" unless
      shard_step&.fetch("env")&.fetch("SNAPLIST_IOS_SHARD") == "${{ matrix.shard }}"

    validate_job = jobs.fetch("validate")
    release_contract_step = validate_job.fetch("steps").find do |step|
      step["name"] == "Validate Release archive configuration"
    end
    abort "Release archive configuration contract changed" unless
      release_contract_step&.fetch("run") == "zsh ios/Scripts/release-config-contract.test.sh"

    pairing_contract_step = validate_job.fetch("steps").find do |step|
      step["name"] == "Validate Clerk instance and API origin pairing"
    end
    abort "Clerk instance and API origin pairing contract changed" unless
      pairing_contract_step&.fetch("run") == "zsh ios/Scripts/clerk-origin-pairing.test.sh"

    release_job = jobs.fetch("release")
    abort "Release configuration must run for pull requests" unless
      release_job.fetch("if") == "github.event_name == '\''pull_request'\''"
    abort "Release configuration must wait for validation" unless
      release_job.fetch("needs") == "validate"
    abort "Release configuration must use the declared Apple runner" unless
      release_job.fetch("runs-on") == "macos-26"
    release_checkout_step = release_job.fetch("steps").find do |step|
      step["uses"] == "actions/checkout@v4"
    end
    abort "Release configuration must check out the exact candidate head" unless
      release_checkout_step&.fetch("with")&.fetch("ref") ==
        "${{ github.event.pull_request.head.sha }}"
    release_step = release_job.fetch("steps").find do |step|
      step["name"] == "Build verified Release configuration"
    end
    abort "Release build command changed" unless
      release_step&.fetch("run") == "ios/Scripts/build-release.sh"
    abort "Release build must inject only a synthetic live Clerk key" unless
      release_step&.fetch("env")&.fetch("SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY") ==
        "pk_live_ci_release_validation"

    aggregate_job = jobs.fetch("test")
    abort "aggregate required check must wait for validation and every shard" unless
      aggregate_job.fetch("needs") == ["validate", "shard", "release"]
    abort "aggregate required check must run after failures" unless
      aggregate_job.fetch("if") == "always() && github.event_name == '\''pull_request'\''"
    aggregate_step = aggregate_job.fetch("steps").find do |step|
      step["name"] == "Require validation and every shard"
    end
    abort "aggregate required check is missing" unless aggregate_step
    abort "aggregate check must observe validation result" unless
      aggregate_step.fetch("env").fetch("VALIDATE_RESULT") == "${{ needs.validate.result }}"
    abort "aggregate check must observe the complete matrix result" unless
      aggregate_step.fetch("env").fetch("SHARD_RESULT") == "${{ needs.shard.result }}"
    abort "aggregate check must observe the Release configuration result" unless
      aggregate_step.fetch("env").fetch("RELEASE_RESULT") == "${{ needs.release.result }}"

    serial_job = jobs.fetch("serial")
    abort "serial confidence must remain on main pushes" unless
      serial_job.fetch("if") == "github.event_name == '\''push'\''"
    abort "serial confidence budget must remain 75 minutes" unless
      serial_job.fetch("timeout-minutes") == 75
    serial_step = serial_job.fetch("steps").find do |step|
      step["name"] == "Build app and run complete serial test suite"
    end
    abort "serial confidence command changed" unless
      serial_step&.fetch("run") == "ios/Scripts/test.sh"
    abort "the Release build must not re-enter the serial budget" if
      serial_job.fetch("steps").any? { |step|
        step["run"] == "ios/Scripts/build-release.sh"
      }

    release_main_job = jobs.fetch("release-main")
    abort "main Release configuration must run for main pushes" unless
      release_main_job.fetch("if") == "github.event_name == '\''push'\''"
    abort "main Release configuration must use the declared Apple runner" unless
      release_main_job.fetch("runs-on") == "macos-26"
    abort "main Release configuration budget must remain 25 minutes" unless
      release_main_job.fetch("timeout-minutes") == 25
    release_main_checkout_step = release_main_job.fetch("steps").find do |step|
      step["uses"] == "actions/checkout@v4"
    end
    abort "main Release configuration must check out the pushed commit" unless
      release_main_checkout_step&.fetch("with")&.fetch("ref") == "${{ github.sha }}"
    release_main_step = release_main_job.fetch("steps").find do |step|
      step["name"] == "Build verified Release configuration"
    end
    abort "main must build the verified Release configuration" unless
      release_main_step&.fetch("run") == "ios/Scripts/build-release.sh"
    abort "main Release build must inject only a synthetic live Clerk key" unless
      release_main_step&.fetch("env")&.fetch("SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY") ==
        "pk_live_ci_release_validation"

    focused_job = jobs.fetch("focused")
    abort "focused dispatch guard changed" unless
      focused_job.fetch("if") == "github.event_name == '\''workflow_dispatch'\''"
    abort "focused dispatch budget must remain 60 minutes" unless
      focused_job.fetch("timeout-minutes") == 60
  ' "$workflow_file" "$shard_inventory_file"
}

assert_focused_selector_uses_the_target_repository() {
  local selector="SnapListTests/CaptureFlowTests/testShutterAccessibleNameOnlyAnnouncesTheLimitAtFiveDurablePhotos"
  : > "$arguments_file"
  : > "$working_directory_file"

  if ! run_test_script set "$selector" "$target_repository"; then
    return 1
  fi

  [[ $(grep -Fxc -- "-only-testing:${selector}" "$arguments_file") -eq 1 ]] &&
    [[ $(<"$working_directory_file") == "$target_repository" ]]
}

assert_malformed_selectors_fail_before_xcodebuild() {
  local selector

  for selector in \
    "" \
    "SnapListTests/CaptureFlowTests/testName;touch ${injection_marker}"
  do
    : > "$arguments_file"

    if run_test_script set "$selector"; then
      return 1
    fi

    if [[ -s $arguments_file || -e $injection_marker ]]; then
      return 1
    fi
  done
}

assert_shard_inventory_fails_closed_on_omission_and_duplication() {
  if [[ ! -x $shard_inventory_validator ]] ||
    ! "$shard_inventory_validator" "$shard_inventory_file"; then
    return 1
  fi

  ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    inventory.fetch("shards").fetch("ui-1").shift
    File.write(ARGV.fetch(1), JSON.pretty_generate(inventory))
  ' "$shard_inventory_file" "$omitted_shard_inventory_file"

  if "$shard_inventory_validator" "$omitted_shard_inventory_file" 2>/dev/null; then
    return 1
  fi

  ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    selector = inventory.fetch("shards").fetch("ui-1").fetch(0)
    inventory.fetch("shards").fetch("ui-2") << selector
    File.write(ARGV.fetch(1), JSON.pretty_generate(inventory))
  ' "$shard_inventory_file" "$duplicated_shard_inventory_file"

  ! "$shard_inventory_validator" "$duplicated_shard_inventory_file" 2>/dev/null
}

assert_shard_inventory_fails_closed_on_empty_declared_shard() {
  ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    ui_selectors = inventory.fetch("shards")
      .select { |name, _selectors| name.start_with?("ui-") }
      .values
      .flatten
    inventory.fetch("shards")["ui-1"] = ui_selectors
    inventory.fetch("shards")["ui-2"] = []
    inventory.fetch("shards")["ui-3"] = []
    inventory.fetch("baseline").fetch("selector_observed_seconds").transform_values! { 0 }
    inventory.fetch("baseline")["selector_seconds_total"] = 0
    inventory.fetch("baseline")["balanced_ui_shard_observed_seconds"] = {
      "ui-1" => 0,
      "ui-2" => 0,
      "ui-3" => 0
    }
    File.write(ARGV.fetch(1), JSON.pretty_generate(inventory))
  ' "$shard_inventory_file" "$empty_shard_inventory_file"

  ! "$shard_inventory_validator" "$empty_shard_inventory_file" 2>/dev/null
}

assert_shard_inventory_fails_closed_on_stale_timing_evidence() {
  ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    inventory.fetch("baseline")["ui_test_count"] -= 1
    File.write(ARGV.fetch(1), JSON.pretty_generate(inventory))
  ' "$shard_inventory_file" "$stale_timing_inventory_file"

  if "$shard_inventory_validator" "$stale_timing_inventory_file" 2>/dev/null; then
    return 1
  fi

  ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    inventory.fetch("baseline")["selector_seconds_total"] += 1
    File.write(ARGV.fetch(1), JSON.pretty_generate(inventory))
  ' "$shard_inventory_file" "$stale_timing_inventory_file"

  if "$shard_inventory_validator" "$stale_timing_inventory_file" 2>/dev/null; then
    return 1
  fi

  ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    inventory.fetch("baseline")
      .fetch("balanced_ui_shard_observed_seconds")["ui-1"] += 1
    File.write(ARGV.fetch(1), JSON.pretty_generate(inventory))
  ' "$shard_inventory_file" "$stale_timing_inventory_file"

  ! "$shard_inventory_validator" "$stale_timing_inventory_file" 2>/dev/null
}

assert_nested_ui_test_file_cannot_be_silently_omitted() {
  local validation_error_file=${temporary_directory}/nested-test-validation-error

  mkdir -p "${nested_test_repository}/ios"
  cp -R "${script_directory:h}/SnapListUITests" "${nested_test_repository}/ios/"

  if ! "$shard_inventory_validator" \
    "$shard_inventory_file" \
    "$nested_test_repository" \
    >/dev/null
  then
    return 1
  fi

  mkdir -p "${nested_test_repository}/ios/SnapListUITests/Flows"

  cat > "${nested_test_repository}/ios/SnapListUITests/Flows/NewFlowTests.swift" <<'EOF'
import XCTest

final class NewFlowTests: XCTestCase {
    func testNestedFlow() {}
}
EOF

  if "$shard_inventory_validator" \
    "$shard_inventory_file" \
    "$nested_test_repository" \
    >/dev/null \
    2>"$validation_error_file"
  then
    return 1
  fi

  grep -Fxq \
    "unassigned UI test selectors: SnapListUITests/NewFlowTests/testNestedFlow" \
    "$validation_error_file"
}

assert_declared_shard_selectors_reach_xcodebuild_once() {
  local shard
  local -a declared_shards
  local expected_arguments_file=${temporary_directory}/expected-xcodebuild-arguments
  declared_shards=(
    "${(@f)$(ruby -rjson -e '
      inventory = JSON.parse(File.read(ARGV.fetch(0)))
      puts ["unit"] +
        (1..inventory.fetch("ui_shard_count")).map { |index| "ui-#{index}" }
    ' "$shard_inventory_file")}"
  )

  for shard in "${declared_shards[@]}"; do
    : > "$arguments_file"
    : > "$expected_arguments_file"

    if ! run_test_script unset "" "" "$shard"; then
      return 1
    fi

    ruby -rjson -e '
      inventory = JSON.parse(File.read(ARGV.fetch(0)))
      inventory.fetch("shards").fetch(ARGV.fetch(1)).each do |selector|
        puts "-only-testing:#{selector}"
      end
    ' "$shard_inventory_file" "$shard" > "$expected_arguments_file"

    if ! diff -u "$expected_arguments_file" \
      <(grep -- "^-only-testing:" "$arguments_file"); then
      return 1
    fi
  done
}

assert_invalid_or_conflicting_shard_selection_fails_before_xcodebuild() {
  local exit_status
  local invalid_shard
  invalid_shard=$(ruby -rjson -e '
    inventory = JSON.parse(File.read(ARGV.fetch(0)))
    puts "ui-#{inventory.fetch("ui_shard_count") + 1}"
  ' "$shard_inventory_file")

  : > "$arguments_file"
  run_test_script unset "" "" "$invalid_shard"
  exit_status=$?

  if [[ $exit_status -ne 64 || -s $arguments_file ]]; then
    return 1
  fi

  : > "$arguments_file"
  run_test_script set \
    "SnapListTests/CaptureFlowTests/testShutterAccessibleNameOnlyAnnouncesTheLimitAtFiveDurablePhotos" \
    "" \
    "unit"
  exit_status=$?

  [[ $exit_status -eq 64 && ! -s $arguments_file ]]
}

assert_manual_dispatch_cannot_cancel_automatic_runs() {
  local candidate_workflow_file=${1:-$workflow_file}

  ruby "$workflow_contract_parser" "$candidate_workflow_file"
}

assert_stale_workflow_text_cannot_mask_broken_active_contract() {
  cat > "$broken_workflow_file" <<'EOF'
name: Broken iOS contract

concurrency:
  group: ios-${{ github.workflow }}-${{ github.ref }}
  # group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true
EOF

  ! assert_manual_dispatch_cannot_cancel_automatic_runs "$broken_workflow_file" 2>/dev/null
}

assert_harmless_workflow_expression_layout_is_ignored() {
  cat > "$formatted_workflow_file" <<'EOF'
name: Formatted iOS contract

concurrency:
  group: >-
    ios-${{
      github.workflow
    }}-${{
      (
        github.event_name == 'workflow_dispatch' &&
        format('dispatch-{0}', github.run_id)
      ) || github.ref
    }}
  cancel-in-progress: true
EOF

  assert_manual_dispatch_cannot_cancel_automatic_runs "$formatted_workflow_file"
}

assert_inactive_workflow_text_cannot_mask_broken_active_contract() {
  cat > "$inactive_workflow_file" <<'EOF'
name: Broken iOS contract with inactive example

concurrency:
  group: ios-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

inactive_example:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
EOF

  ! assert_manual_dispatch_cannot_cancel_automatic_runs "$inactive_workflow_file" 2>/dev/null
}

assert_fixed_samples_cannot_mask_a_non_run_scoped_manual_contract() {
  cat > "$sample_gaming_workflow_file" <<'EOF'
name: Broken iOS contract that games fixed samples

concurrency:
  group: >-
    ios-${{ github.workflow }}-${{
      github.event_name == 'workflow_dispatch' &&
      (
        (github.run_id == '702' || github.run_id == '703') &&
        format('dispatch-{0}', github.run_id) ||
        github.ref
      ) ||
      github.ref
    }}
  cancel-in-progress: true
EOF

  ! assert_manual_dispatch_cannot_cancel_automatic_runs "$sample_gaming_workflow_file" 2>/dev/null
}

assert_concrete_formatting_remains_semantically_equivalent() {
  cat > "$concrete_format_workflow_file" <<'EOF'
name: Semantically formatted iOS contract

concurrency:
  group: >-
    ios-${{ github.workflow }}-${{
      format('{0}', github.event_name) == 'workflow_dispatch' &&
      format('dispatch-{0}', github.run_id) ||
      github.ref
    }}
  cancel-in-progress: true
EOF

  assert_manual_dispatch_cannot_cancel_automatic_runs "$concrete_format_workflow_file"
}

assert_job_level_override_cannot_reshare_the_automatic_group() {
  cat > "$job_override_workflow_file" <<'EOF'
name: Broken iOS contract with a job-level override

concurrency:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    concurrency:
      group: ios-${{ github.workflow }}-${{ github.ref }}
      cancel-in-progress: true
EOF

  ! assert_manual_dispatch_cannot_cancel_automatic_runs "$job_override_workflow_file" 2>/dev/null
}

assert_job_level_isolation_is_still_accepted() {
  cat > "$job_isolated_workflow_file" <<'EOF'
name: iOS contract with an isolated job-level group

concurrency:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    concurrency:
      group: ios-test-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
      cancel-in-progress: true
EOF

  assert_manual_dispatch_cannot_cancel_automatic_runs "$job_isolated_workflow_file"
}

assert_job_level_manual_dispatches_cannot_cancel_each_other() {
  cat > "$job_shared_dispatch_workflow_file" <<'EOF'
name: iOS contract whose job group collapses every manual dispatch

concurrency:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    concurrency:
      group: ios-test-${{ github.event_name == 'workflow_dispatch' && 'dispatch' || github.ref }}
      cancel-in-progress: true
EOF

  ! assert_manual_dispatch_cannot_cancel_automatic_runs "$job_shared_dispatch_workflow_file" 2>/dev/null
}

assert_job_level_matrix_isolation_is_accepted() {
  cat > "$job_matrix_workflow_file" <<'EOF'
name: iOS contract whose isolated job group keys on a matrix value

concurrency:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    concurrency:
      group: ios-${{ matrix.device }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
      cancel-in-progress: true
EOF

  assert_manual_dispatch_cannot_cancel_automatic_runs "$job_matrix_workflow_file"
}

assert_a_misspelled_job_context_is_still_rejected() {
  cat > "$job_typo_workflow_file" <<'EOF'
name: iOS contract whose job group misspells a github context

concurrency:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    concurrency:
      group: ios-test-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.rev }}
      cancel-in-progress: true
EOF

  ! assert_manual_dispatch_cannot_cancel_automatic_runs "$job_typo_workflow_file" 2>/dev/null
}

assert_a_job_group_unique_to_every_run_is_accepted() {
  cat > "$job_run_scoped_workflow_file" <<'EOF'
name: iOS contract whose job group is unique to every run

concurrency:
  group: ios-${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id) || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    concurrency:
      group: ios-test-${{ github.run_id }}
      cancel-in-progress: false
EOF

  assert_manual_dispatch_cannot_cancel_automatic_runs "$job_run_scoped_workflow_file"
}

run_serialized_test_script() {
  local selector=$1
  local diagnostics_file=$2
  local sleep_seconds=$3

  (
    export PATH="${serialized_bin}:${PATH}"
    export SNAPLIST_IOS_LOCK_FILE=$lock_file
    # Without these the production defaults apply, so a release regression
    # would sit on a stale lock for two hours before exiting 75. The suite
    # would look hung rather than red.
    export SNAPLIST_IOS_LOCK_POLL_SECONDS=1
    export SNAPLIST_IOS_LOCK_TIMEOUT_SECONDS=30
    export SNAPLIST_IOS_ONLY_TESTING=$selector
    export SNAPLIST_XCODEBUILD_ACTIVE_MARKER=$serialized_active_marker
    export SNAPLIST_XCODEBUILD_OVERLAP_LOG=$serialized_overlap_log
    export SNAPLIST_XCODEBUILD_STARTED_LOG=$serialized_started_log
    export SNAPLIST_XCODEBUILD_DESCENDANT_LOG=$serialized_descendant_log
    export SNAPLIST_XCODEBUILD_SLEEP_SECONDS=$sleep_seconds
    export SNAPLIST_XCODEBUILD_EXIT_STATUS=${4:-0}

    unset SNAPLIST_IOS_SHARD
    unset SNAPLIST_IOS_REPOSITORY_ROOT

    "$test_script"
  ) >/dev/null 2>"$diagnostics_file"
}

run_shard_timeout_test_script() {
  local shard=$1
  local sleep_seconds=$2
  local warn_seconds=$3
  local kill_seconds=$4
  local diagnostics_file=$5

  (
    export PATH="${serialized_bin}:${PATH}"
    export SNAPLIST_IOS_LOCK_FILE=$lock_file
    export SNAPLIST_IOS_LOCK_POLL_SECONDS=1
    export SNAPLIST_IOS_LOCK_TIMEOUT_SECONDS=30
    export SNAPLIST_XCODEBUILD_ACTIVE_MARKER=$serialized_active_marker
    export SNAPLIST_XCODEBUILD_OVERLAP_LOG=$serialized_overlap_log
    export SNAPLIST_XCODEBUILD_STARTED_LOG=$serialized_started_log
    export SNAPLIST_XCODEBUILD_DESCENDANT_LOG=$serialized_descendant_log
    export SNAPLIST_XCODEBUILD_SLEEP_SECONDS=$sleep_seconds
    export SNAPLIST_XCODEBUILD_EXIT_STATUS=0
    export SNAPLIST_IOS_SHARD_TIMEOUT_POLL_SECONDS=1
    export SNAPLIST_IOS_SHARD_TIMEOUT_KILL_GRACE_SECONDS=1

    # Only the thresholds a case actually names are overridden. Leaving one
    # unset keeps the real budget file in the path, which is the point of
    # `assert_a_shard_warns_at_the_declared_budget_before_it_kills`.
    if [[ -n $warn_seconds ]]; then
      export SNAPLIST_IOS_SHARD_WARN_SECONDS=$warn_seconds
    else
      unset SNAPLIST_IOS_SHARD_WARN_SECONDS
    fi

    if [[ -n $kill_seconds ]]; then
      export SNAPLIST_IOS_SHARD_KILL_SECONDS=$kill_seconds
    else
      unset SNAPLIST_IOS_SHARD_KILL_SECONDS
    fi

    unset SNAPLIST_IOS_ONLY_TESTING
    unset SNAPLIST_IOS_REPOSITORY_ROOT

    if [[ -n $shard ]]; then
      export SNAPLIST_IOS_SHARD=$shard
    else
      unset SNAPLIST_IOS_SHARD
    fi

    "$test_script"
  ) >/dev/null 2>"$diagnostics_file"
}

assert_a_concurrent_invocation_waits_for_the_holder_instead_of_colliding() {
  local holder_job holder_status waiter_status
  local polls=0
  local acquisition_delay

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$holder_diagnostics_file"
  : > "$waiter_diagnostics_file"

  run_serialized_test_script "$holder_selector" "$holder_diagnostics_file" 4 &
  holder_job=$!

  while [[ ! -d $serialized_active_marker ]]; do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 200 )); then
      kill "$holder_job" 2>/dev/null
      wait "$holder_job" 2>/dev/null
      return 1
    fi
  done

  run_serialized_test_script \
    "SnapListTests/LockWaiterProbeTests/testWaitsForTheBuildLock" \
    "$waiter_diagnostics_file" \
    1
  waiter_status=$?

  wait "$holder_job"
  holder_status=$?

  if (( holder_status != 0 || waiter_status != 0 )); then
    return 1
  fi

  if [[ -s $serialized_overlap_log ]]; then
    return 1
  fi

  if [[ $(grep -c . "$serialized_started_log") -ne 2 ]]; then
    return 1
  fi

  if grep -Fq -- "Waiting for the iOS build lock" "$holder_diagnostics_file"; then
    return 1
  fi

  if ! grep -Fq -- "Waiting for the iOS build lock at ${lock_file}" \
    "$waiter_diagnostics_file"; then
    return 1
  fi

  if ! grep -Eq -- "held by pid [0-9]+" "$waiter_diagnostics_file"; then
    return 1
  fi

  if ! grep -Fq -- "$holder_selector" "$waiter_diagnostics_file"; then
    return 1
  fi

  acquisition_delay=$(
    sed -n 's/.*Acquired the iOS build lock after \([0-9][0-9]*\)s.*/\1/p' \
      "$waiter_diagnostics_file" | tail -n 1
  )

  [[ -n $acquisition_delay ]] && (( acquisition_delay >= 1 ))
}

assert_a_failing_build_leaves_no_lock_behind() {
  local failing_status successor_status

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$holder_diagnostics_file"
  : > "$waiter_diagnostics_file"

  run_serialized_test_script "$holder_selector" "$holder_diagnostics_file" 0 65
  failing_status=$?

  if (( failing_status != 65 )); then
    return 1
  fi

  if [[ -e ${lock_file}.owner ]]; then
    return 1
  fi

  run_serialized_test_script \
    "SnapListTests/LockSuccessorProbeTests/testTakesTheReleasedLock" \
    "$waiter_diagnostics_file" \
    0
  successor_status=$?

  if (( successor_status != 0 )); then
    return 1
  fi

  ! grep -Fq -- "Waiting for the iOS build lock" "$waiter_diagnostics_file"
}

assert_a_waiting_invocation_keeps_reporting_while_it_waits() {
  local holder_job holder_status waiter_status reported
  local previous=-1
  local polls=0
  typeset -a reported_waits

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$holder_diagnostics_file"
  : > "$waiter_diagnostics_file"

  run_serialized_test_script "$holder_selector" "$holder_diagnostics_file" 5 &
  holder_job=$!

  while [[ ! -d $serialized_active_marker ]]; do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 200 )); then
      kill "$holder_job" 2>/dev/null
      wait "$holder_job" 2>/dev/null
      return 1
    fi
  done

  run_serialized_test_script \
    "SnapListTests/LockReportingProbeTests/testKeepsReportingWhileItWaits" \
    "$waiter_diagnostics_file" \
    0
  waiter_status=$?

  wait "$holder_job"
  holder_status=$?

  if (( holder_status != 0 || waiter_status != 0 )); then
    return 1
  fi

  reported_waits=(
    "${(@f)$(
      sed -n 's/.*Waiting for the iOS build lock .*waited \([0-9][0-9]*\)s\./\1/p' \
        "$waiter_diagnostics_file"
    )}"
  )

  # Three lines rather than one. A run that announces the wait once and then
  # goes quiet for the rest of a build reads exactly like a run that hung,
  # and that is the one an agent kills.
  if (( ${#reported_waits} < 3 )); then
    return 1
  fi

  # Strictly increasing, so the same line repeated forever cannot satisfy the
  # count. The elapsed figure is the part that proves the run is still alive.
  for reported in "${reported_waits[@]}"; do
    if (( reported <= previous )); then
      return 1
    fi

    previous=$reported
  done

  # Every line names the holder, not just the first one. A waiter that starts
  # reporting an anonymous lock halfway through is back to being unactionable.
  (( $(grep -c -- "held by pid [0-9]" "$waiter_diagnostics_file") \
    >= ${#reported_waits} ))
}

assert_the_first_wait_report_names_a_holder_that_records_itself_late() {
  local holder_job waiter_status first_report
  local polls=0

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$waiter_diagnostics_file"
  rm -f "${lock_file}.holder-ready"

  # The other lock cases start their waiter only after the holder is already
  # deep inside xcodebuild, so the owner file is always there to read. Two
  # agents that start in the same second do not get that courtesy: the waiter's
  # first poll can beat the holder's write by microseconds. This holder makes
  # that window explicit and holds it open for a second, which is why it takes
  # the flock itself instead of going through the script under test.
  (
    zmodload zsh/system
    : >> "$lock_file"
    zsystem flock -f late_recorder_descriptor "$lock_file"
    : > "${lock_file}.holder-ready"
    sleep 1
    print -r -- \
      "held by pid $$ in /late/recorder running ${holder_selector} since 2026-01-01T00:00:00Z" \
      > "${lock_file}.owner"
    sleep 2
    rm -f "${lock_file}.owner"
    zsystem flock -u "$late_recorder_descriptor"
  ) &
  holder_job=$!

  while [[ ! -e ${lock_file}.holder-ready ]]; do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 200 )); then
      kill "$holder_job" 2>/dev/null
      wait "$holder_job" 2>/dev/null
      return 1
    fi
  done

  run_serialized_test_script \
    "SnapListTests/LockWaiterProbeTests/testWaitsForTheBuildLock" \
    "$waiter_diagnostics_file" \
    1
  waiter_status=$?

  wait "$holder_job" 2>/dev/null
  rm -f "${lock_file}.holder-ready"

  if (( waiter_status != 0 )); then
    return 1
  fi

  first_report=$(
    grep -F -- "Waiting for the iOS build lock" "$waiter_diagnostics_file" \
      | head -n 1
  )

  # Naming the holder one poll later is not the same thing. The first line is
  # the one an agent reads before deciding whether the run is stuck.
  [[ $first_report == *"held by pid "* && $first_report == *"${holder_selector}"* ]]
}

assert_a_terminated_holder_leaves_no_stale_owner_behind() {
  local holder_job recorded_owner holder_pid
  local polls=0

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$holder_diagnostics_file"

  run_serialized_test_script "$holder_selector" "$holder_diagnostics_file" 3 &
  holder_job=$!

  while [[ ! -d $serialized_active_marker ]]; do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 200 )); then
      kill "$holder_job" 2>/dev/null
      wait "$holder_job" 2>/dev/null
      return 1
    fi
  done

  recorded_owner=$(<"${lock_file}.owner")
  holder_pid=${${(z)recorded_owner}[4]}

  if [[ $holder_pid != <-> ]]; then
    kill "$holder_job" 2>/dev/null
    wait "$holder_job" 2>/dev/null
    return 1
  fi

  # An agent that decides a build has hung sends SIGTERM, and zsh does not run
  # TRAPEXIT for an untrapped one. That is the path that leaves a pid nobody
  # can reach in the file the next waiter reads out loud.
  kill -TERM "$holder_pid"
  wait "$holder_job" 2>/dev/null

  if [[ -e ${lock_file}.owner ]]; then
    return 1
  fi

  # The build no longer outlives the run that started it, so nothing is left to
  # clear the marker. Whether it was actually reaped is the next case's claim;
  # this one only owns the owner file.
  rm -rf "$serialized_active_marker"

  return 0
}

# A backgrounded child does not defer trap delivery the way a foreground one
# does, so these handlers now run while xcodebuild is still alive. Releasing
# the lock there is worse than never releasing it: `test.sh` reports the lock
# free while its build still holds the simulator and DerivedData, and the next
# invocation in another worktree takes the flock and starts a second one.
assert_a_terminated_holder_reaps_its_build_before_releasing_the_lock() {
  local holder_job recorded_owner holder_pid build_pid descendant_pid
  local polls=0

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$serialized_descendant_log"
  : > "$holder_diagnostics_file"

  run_serialized_test_script "$holder_selector" "$holder_diagnostics_file" 120 &
  holder_job=$!

  # Both logs, not just the marker. The fake records its own pid and then its
  # descendant's, and reading either one early yields an empty string that
  # would make the liveness checks below vacuously true.
  while [[ ! -d $serialized_active_marker ]] ||
    [[ ! -s $serialized_started_log ]] ||
    [[ ! -s $serialized_descendant_log ]]
  do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 200 )); then
      kill "$holder_job" 2>/dev/null
      wait "$holder_job" 2>/dev/null
      return 1
    fi
  done

  recorded_owner=$(<"${lock_file}.owner")
  holder_pid=${${(z)recorded_owner}[4]}
  build_pid=$(head -n 1 "$serialized_started_log")
  descendant_pid=$(head -n 1 "$serialized_descendant_log")

  if [[ $holder_pid != <-> || $build_pid != <-> || $descendant_pid != <-> ]]; then
    kill "$holder_job" 2>/dev/null
    wait "$holder_job" 2>/dev/null
    return 1
  fi

  kill -TERM "$holder_pid"
  wait "$holder_job" 2>/dev/null

  polls=0

  while kill -0 "$build_pid" 2>/dev/null || kill -0 "$descendant_pid" 2>/dev/null; do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 100 )); then
      kill -KILL "$build_pid" "$descendant_pid" 2>/dev/null
      rm -rf "$serialized_active_marker"
      return 1
    fi
  done

  rm -rf "$serialized_active_marker"

  [[ ! -e ${lock_file}.owner ]]
}

assert_a_hung_shard_is_killed_with_a_named_annotation() {
  local exit_status

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$serialized_descendant_log"
  : > "$shard_timeout_diagnostics_file"

  run_shard_timeout_test_script "ui-1" 30 1 1 "$shard_timeout_diagnostics_file"
  exit_status=$?

  rm -rf "$serialized_active_marker"

  if [[ $exit_status -ne 124 ]]; then
    return 1
  fi

  grep -q -- "::error::iOS shard ui-1" "$shard_timeout_diagnostics_file" &&
    grep -q -- "exceeded its wall-clock budget" "$shard_timeout_diagnostics_file"
}

# The kill threshold sits above the acceptance budget on purpose. A shard that
# drifts past #936's 30 minute acceptance criterion has broken the criterion,
# not the build, and killing it would turn a slow runner into a red check. So
# the budget annotates and the margin above it kills. Without the warning the
# criterion is unobservable: a 31 minute shard is green and silent.
assert_a_shard_warns_at_the_declared_budget_before_it_kills() {
  local exit_status

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$serialized_descendant_log"
  : > "$shard_timeout_diagnostics_file"

  run_shard_timeout_test_script "ui-1" 6 1 30 "$shard_timeout_diagnostics_file"
  exit_status=$?

  rm -rf "$serialized_active_marker"

  # The build outlives the warning and then succeeds. A warning that only
  # appears on the way to a kill would prove nothing about the split.
  if [[ $exit_status -ne 0 ]]; then
    return 1
  fi

  grep -q -- "::warning::iOS shard ui-1" "$shard_timeout_diagnostics_file" &&
    ! grep -q -- "::error::" "$shard_timeout_diagnostics_file"
}

# `${+SNAPLIST_IOS_SHARD}` at ios/Scripts/test.sh is the whole reason `serial`,
# `focused` and every local invocation are untouched by this budget. Overriding
# a threshold here would let the override branch decide the outcome and leave
# that guard unexercised, so this case sets neither.
assert_the_wall_clock_budget_does_not_apply_without_a_declared_shard() {
  local exit_status

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$serialized_descendant_log"
  : > "$shard_timeout_diagnostics_file"

  run_shard_timeout_test_script "" 1 "" "" "$shard_timeout_diagnostics_file"
  exit_status=$?

  rm -rf "$serialized_active_marker"

  if [[ $exit_status -ne 0 || -s $shard_timeout_diagnostics_file ]]; then
    return 1
  fi

  # The run above cannot tell the two cases apart on its own: a one second
  # build finishes inside a real thirty minute budget whether the guard fired
  # or not. Replacing the guard with `if true` has to be visible, so read the
  # derivation out directly and require no budget at all.
  [[ $(print_shard_wall_clock_plan "") == "warn=0 kill=0" ]]
}

# The deadline is anchored at the start of this script, not at the moment
# xcodebuild launched, because a wall-clock budget that excludes the lock wait
# is not a wall-clock budget. Anchored at launch, a contended run could spend
# SNAPLIST_IOS_LOCK_TIMEOUT_SECONDS waiting and then still claim a full budget
# on top of it.
assert_the_budget_counts_time_spent_waiting_for_the_build_lock() {
  local holder_job waiter_status
  local polls=0

  rm -rf "$serialized_active_marker" "$lock_file" "${lock_file}.owner"
  : > "$serialized_overlap_log"
  : > "$serialized_started_log"
  : > "$serialized_descendant_log"
  : > "$holder_diagnostics_file"
  : > "$shard_timeout_diagnostics_file"

  run_serialized_test_script "$holder_selector" "$holder_diagnostics_file" 8 &
  holder_job=$!

  while [[ ! -d $serialized_active_marker ]]; do
    sleep 0.1
    polls=$((polls + 1))

    if (( polls > 200 )); then
      kill "$holder_job" 2>/dev/null
      wait "$holder_job" 2>/dev/null
      return 1
    fi
  done

  # Its whole budget is gone before it ever holds the lock, and the build it
  # then starts is short enough to finish inside a budget measured from launch.
  run_shard_timeout_test_script "ui-1" 2 2 3 "$shard_timeout_diagnostics_file"
  waiter_status=$?

  wait "$holder_job" 2>/dev/null
  rm -rf "$serialized_active_marker"

  [[ $waiter_status -eq 124 ]] &&
    grep -q -- "::error::iOS shard ui-1" "$shard_timeout_diagnostics_file"
}

print_shard_wall_clock_plan() {
  local shard=$1
  local budget_file=${2:-$shard_wall_clock_budget_file}

  (
    export PATH="${serialized_bin}:${PATH}"
    export SNAPLIST_IOS_SHARD_BUDGET_FILE=$budget_file

    if [[ -n $shard ]]; then
      export SNAPLIST_IOS_SHARD=$shard
    else
      unset SNAPLIST_IOS_SHARD
    fi

    unset SNAPLIST_IOS_ONLY_TESTING
    unset SNAPLIST_IOS_REPOSITORY_ROOT
    unset SNAPLIST_IOS_SHARD_WARN_SECONDS
    unset SNAPLIST_IOS_SHARD_KILL_SECONDS

    "$test_script" --print-shard-wall-clock-plan
  ) 2>/dev/null
}

# Both timeout cases above override their thresholds, and the workflow cases
# below only compare the file to a literal, so nothing yet proves the file
# reaches the code that consumes it. Deleting the read, inverting the
# arithmetic, or adding the margin instead of subtracting it all have to turn
# this red.
assert_the_wall_clock_budget_file_is_what_the_shard_actually_uses() {
  local declared_minutes plan warn_seconds

  declared_minutes=$(<"$shard_wall_clock_budget_file")
  plan=$(print_shard_wall_clock_plan ui-1) || return 1
  warn_seconds=${${(s: :)plan}[1]#warn=}

  [[ $warn_seconds == $(( declared_minutes * 60 )) ]]
}

# One value cannot separate "reads the file" from "happens to agree with the
# file". A second, different value can.
assert_a_changed_wall_clock_budget_moves_the_thresholds_with_it() {
  local plan warn_seconds kill_seconds

  print -r -- 7 > "$substitute_shard_wall_clock_budget_file"

  plan=$(print_shard_wall_clock_plan ui-1 "$substitute_shard_wall_clock_budget_file") || return 1
  warn_seconds=${${(s: :)plan}[1]#warn=}
  kill_seconds=${${(s: :)plan}[2]#kill=}

  [[ $warn_seconds == 420 ]] && (( kill_seconds > warn_seconds ))
}

read_workflow_shard_timeout_minutes() {
  ruby -ryaml -e '
    workflow = YAML.load_file(ARGV.fetch(0))
    puts workflow.fetch("jobs").fetch("shard").fetch("timeout-minutes")
  ' "${1:-$workflow_file}"
}

# The job-level cap is asserted as a relationship to the derived kill
# threshold rather than as a second copy of the budget, so the budget stays
# stated in exactly one place. It has to sit above the kill, or GitHub's own
# cap fires first with nothing but "The operation was canceled." — the failure
# mode #936 was opened for — and close enough above it that a hung shard is
# not paid for twice.
assert_the_job_cap_leaves_room_for_the_shard_to_report_its_own_timeout() {
  local plan kill_seconds job_cap_seconds

  plan=$(print_shard_wall_clock_plan ui-1) || return 1
  kill_seconds=${${(s: :)plan}[2]#kill=}
  job_cap_seconds=$(( $(read_workflow_shard_timeout_minutes) * 60 ))

  (( job_cap_seconds > kill_seconds )) &&
    (( job_cap_seconds - kill_seconds <= 300 ))
}

failures=0

for contract_case in \
  assert_default_runs_the_full_suite \
  assert_workflow_parallelizes_pr_shards_and_retains_main_serial_confidence \
  assert_focused_selector_uses_the_target_repository \
  assert_malformed_selectors_fail_before_xcodebuild \
  assert_shard_inventory_fails_closed_on_omission_and_duplication \
  assert_shard_inventory_fails_closed_on_empty_declared_shard \
  assert_shard_inventory_fails_closed_on_stale_timing_evidence \
  assert_nested_ui_test_file_cannot_be_silently_omitted \
  assert_declared_shard_selectors_reach_xcodebuild_once \
  assert_invalid_or_conflicting_shard_selection_fails_before_xcodebuild \
  assert_manual_dispatch_cannot_cancel_automatic_runs \
  assert_stale_workflow_text_cannot_mask_broken_active_contract \
  assert_harmless_workflow_expression_layout_is_ignored \
  assert_inactive_workflow_text_cannot_mask_broken_active_contract \
  assert_fixed_samples_cannot_mask_a_non_run_scoped_manual_contract \
  assert_concrete_formatting_remains_semantically_equivalent \
  assert_job_level_override_cannot_reshare_the_automatic_group \
  assert_job_level_isolation_is_still_accepted \
  assert_job_level_manual_dispatches_cannot_cancel_each_other \
  assert_job_level_matrix_isolation_is_accepted \
  assert_a_misspelled_job_context_is_still_rejected \
  assert_a_job_group_unique_to_every_run_is_accepted \
  assert_a_concurrent_invocation_waits_for_the_holder_instead_of_colliding \
  assert_a_waiting_invocation_keeps_reporting_while_it_waits \
  assert_a_failing_build_leaves_no_lock_behind \
  assert_a_terminated_holder_leaves_no_stale_owner_behind \
  assert_the_first_wait_report_names_a_holder_that_records_itself_late \
  assert_a_terminated_holder_reaps_its_build_before_releasing_the_lock \
  assert_a_hung_shard_is_killed_with_a_named_annotation \
  assert_a_shard_warns_at_the_declared_budget_before_it_kills \
  assert_the_wall_clock_budget_does_not_apply_without_a_declared_shard \
  assert_the_budget_counts_time_spent_waiting_for_the_build_lock \
  assert_the_wall_clock_budget_file_is_what_the_shard_actually_uses \
  assert_a_changed_wall_clock_budget_moves_the_thresholds_with_it \
  assert_the_job_cap_leaves_room_for_the_shard_to_report_its_own_timeout
do
  if $contract_case; then
    print -r -- "PASS ${contract_case}"
  else
    print -u2 -r -- "FAIL ${contract_case}"
    failures=$((failures + 1))
  fi
done

exit $failures

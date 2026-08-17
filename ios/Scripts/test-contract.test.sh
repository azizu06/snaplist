#!/bin/zsh

set -u
set -o pipefail

script_directory=${0:A:h}
test_script=${script_directory}/test.sh
workflow_file=${script_directory:h:h}/.github/workflows/ios.yml
workflow_contract_parser=${script_directory}/validate-workflow-concurrency.rb
shard_inventory_file=${script_directory}/test-shards.json
shard_inventory_validator=${script_directory}/validate-test-shards.rb
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

mkdir -p "$fake_bin" "$target_repository"

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
  assert_a_job_group_unique_to_every_run_is_accepted
do
  if $contract_case; then
    print -r -- "PASS ${contract_case}"
  else
    print -u2 -r -- "FAIL ${contract_case}"
    failures=$((failures + 1))
  fi
done

exit $failures

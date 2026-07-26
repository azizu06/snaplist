#!/bin/zsh

set -u
set -o pipefail

script_directory=${0:A:h}
test_script=${script_directory}/test.sh
workflow_file=${script_directory:h:h}/.github/workflows/ios.yml
workflow_contract_parser=${script_directory}/validate-workflow-concurrency.rb
app_navigation_file=${script_directory:h}/SnapList/Navigation/AppNavigation.swift
entitlements_file=${script_directory:h}/SnapList/SnapList.entitlements
info_plist_file=${script_directory:h}/SnapList/Info.plist
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

assert_run_deep_link_and_entitlement_contract() {
  ! grep -Fq 'case ("https"' "$app_navigation_file" &&
    ! grep -Fq 'applinks:' "$app_navigation_file" &&
    ! grep -Fq 'snaplist.dev' "$app_navigation_file" &&
    /usr/bin/plutil -convert json -o - "$entitlements_file" |
      ruby -rjson -e '
        domains = JSON.parse(STDIN.read).fetch("com.apple.developer.associated-domains")
        expected = ["webcredentials:witty-walrus-27.clerk.accounts.dev"]
        abort "associated domains must preserve only Clerk webcredentials" unless domains == expected
      ' &&
    [[ $(/usr/bin/plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes.0 raw "$info_plist_file") == "snaplist" ]]
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
  assert_focused_selector_uses_the_target_repository \
  assert_run_deep_link_and_entitlement_contract \
  assert_malformed_selectors_fail_before_xcodebuild \
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

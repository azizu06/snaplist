#!/bin/zsh

set -u
set -o pipefail

script_directory=${0:A:h}
test_script=${script_directory}/test.sh
workflow_file=${script_directory:h:h}/.github/workflows/ios.yml
workflow_contract_parser=${script_directory}/validate-workflow-concurrency.rb
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

failures=0

for contract_case in \
  assert_default_runs_the_full_suite \
  assert_focused_selector_uses_the_target_repository \
  assert_malformed_selectors_fail_before_xcodebuild \
  assert_manual_dispatch_cannot_cancel_automatic_runs \
  assert_stale_workflow_text_cannot_mask_broken_active_contract \
  assert_harmless_workflow_expression_layout_is_ignored \
  assert_inactive_workflow_text_cannot_mask_broken_active_contract
do
  if $contract_case; then
    print -r -- "PASS ${contract_case}"
  else
    print -u2 -r -- "FAIL ${contract_case}"
    failures=$((failures + 1))
  fi
done

exit $failures

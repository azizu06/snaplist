#!/bin/zsh

set -u
set -o pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
generator=${script_directory}/generate-test-shards.rb
validator=${script_directory}/validate-test-shards.rb
committed_inventory_file=${script_directory}/test-shards.json
committed_timings_file=${script_directory}/test-shard-timings.json
temporary_parent=${TMPDIR:-/tmp}
temporary_directory=$(mktemp -d "${temporary_parent%/}/snaplist-shard-generator.XXXXXX")
regenerated_inventory_file=${temporary_directory}/regenerated-test-shards.json
rerun_inventory_file=${temporary_directory}/rerun-test-shards.json
fixture_repository=${temporary_directory}/fixture-repository
fixture_timings_file=${temporary_directory}/fixture-timings.json
fixture_inventory_file=${temporary_directory}/fixture-test-shards.json
incomplete_fixture_timings_file=${temporary_directory}/incomplete-fixture-timings.json
missing_timing_error_file=${temporary_directory}/missing-timing-error
zero_default_inventory_file=${temporary_directory}/zero-default-test-shards.json

cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

write_fixture_ui_test_tree() {
  local target=$1

  rm -rf "$target"
  mkdir -p "${target}/ios/SnapListUITests"

  cat > "${target}/ios/SnapListUITests/SampleFlowUITests.swift" <<'EOF'
import XCTest

final class SampleFlowUITests: XCTestCase {
    func testOpensTheSampleFlow() {}
    func testClosesTheSampleFlow() {}
}
EOF
}

write_fixture_timings_file() {
  local target=$1

  cat > "$target" <<'EOF'
{
  "ui_shard_count": 1,
  "execution_model": {
    "build_products": "isolated-per-shard",
    "reason": "fixture"
  },
  "baseline_provenance": {
    "run_id": 1,
    "head_sha": "0000000000000000000000000000000000000000",
    "merged_tree_sha": "0000000000000000000000000000000000000000",
    "measured_layout_ui_shard_count": 1,
    "xcode_version": "26.5",
    "xcode_build": "17F42",
    "unit_test_count": 1,
    "source_ui_shard_suite_seconds": {
      "ui-1": 2.5
    }
  },
  "selector_observed_seconds": {
    "SnapListUITests/SampleFlowUITests/testOpensTheSampleFlow": 1.5,
    "SnapListUITests/SampleFlowUITests/testClosesTheSampleFlow": 1.0
  }
}
EOF
}

assert_generator_reproduces_the_committed_inventory_byte_identically() {
  if ! [[ -x $generator ]]; then
    return 1
  fi

  "$generator" \
    "$committed_timings_file" \
    "$repository_root" \
    "$regenerated_inventory_file" \
    >/dev/null || return 1

  diff -u "$committed_inventory_file" "$regenerated_inventory_file"
}

assert_rerunning_on_an_unchanged_tree_is_byte_identical() {
  "$generator" \
    "$committed_timings_file" \
    "$repository_root" \
    "$regenerated_inventory_file" \
    >/dev/null || return 1

  "$generator" \
    "$committed_timings_file" \
    "$repository_root" \
    "$rerun_inventory_file" \
    >/dev/null || return 1

  diff -u "$regenerated_inventory_file" "$rerun_inventory_file"
}

assert_generated_inventory_is_validator_accepted() {
  "$generator" \
    "$committed_timings_file" \
    "$repository_root" \
    "$regenerated_inventory_file" \
    >/dev/null || return 1

  "$validator" "$regenerated_inventory_file" "$repository_root"
}

assert_fixture_tree_with_a_new_test_and_timing_produces_a_validator_accepted_file() {
  write_fixture_ui_test_tree "$fixture_repository"
  write_fixture_timings_file "$fixture_timings_file"

  "$generator" \
    "$fixture_timings_file" \
    "$fixture_repository" \
    "$fixture_inventory_file" \
    >/dev/null || return 1

  "$validator" "$fixture_inventory_file" "$fixture_repository"
}

assert_missing_timing_for_a_discovered_selector_is_a_hard_error_naming_it() {
  write_fixture_ui_test_tree "$fixture_repository"

  cat > "$incomplete_fixture_timings_file" <<'EOF'
{
  "ui_shard_count": 1,
  "execution_model": {
    "build_products": "isolated-per-shard",
    "reason": "fixture"
  },
  "baseline_provenance": {
    "run_id": 1,
    "head_sha": "0000000000000000000000000000000000000000",
    "merged_tree_sha": "0000000000000000000000000000000000000000",
    "measured_layout_ui_shard_count": 1,
    "xcode_version": "26.5",
    "xcode_build": "17F42",
    "unit_test_count": 1,
    "source_ui_shard_suite_seconds": {
      "ui-1": 1.5
    }
  },
  "selector_observed_seconds": {
    "SnapListUITests/SampleFlowUITests/testOpensTheSampleFlow": 1.5
  }
}
EOF

  if "$generator" \
    "$incomplete_fixture_timings_file" \
    "$fixture_repository" \
    "$fixture_inventory_file" \
    >/dev/null \
    2>"$missing_timing_error_file"
  then
    return 1
  fi

  grep -Fq \
    "SnapListUITests/SampleFlowUITests/testClosesTheSampleFlow" \
    "$missing_timing_error_file"
}

assert_missing_timing_never_defaults_to_zero() {
  write_fixture_ui_test_tree "$fixture_repository"

  cat > "$incomplete_fixture_timings_file" <<'EOF'
{
  "ui_shard_count": 1,
  "execution_model": {
    "build_products": "isolated-per-shard",
    "reason": "fixture"
  },
  "baseline_provenance": {
    "run_id": 1,
    "head_sha": "0000000000000000000000000000000000000000",
    "merged_tree_sha": "0000000000000000000000000000000000000000",
    "measured_layout_ui_shard_count": 1,
    "xcode_version": "26.5",
    "xcode_build": "17F42",
    "unit_test_count": 1,
    "source_ui_shard_suite_seconds": {
      "ui-1": 1.5
    }
  },
  "selector_observed_seconds": {
    "SnapListUITests/SampleFlowUITests/testOpensTheSampleFlow": 1.5
  }
}
EOF

  "$generator" \
    "$incomplete_fixture_timings_file" \
    "$fixture_repository" \
    "$zero_default_inventory_file" \
    >/dev/null 2>/dev/null

  ! [[ -f $zero_default_inventory_file ]]
}

assert_generator_and_validator_share_no_packing_code() {
  ! grep -Eq 'require_relative' "$generator" "$validator" 2>/dev/null
}

failures=0

for contract_case in \
  assert_generator_reproduces_the_committed_inventory_byte_identically \
  assert_rerunning_on_an_unchanged_tree_is_byte_identical \
  assert_generated_inventory_is_validator_accepted \
  assert_fixture_tree_with_a_new_test_and_timing_produces_a_validator_accepted_file \
  assert_missing_timing_for_a_discovered_selector_is_a_hard_error_naming_it \
  assert_missing_timing_never_defaults_to_zero \
  assert_generator_and_validator_share_no_packing_code
do
  if [[ -n ${SNAPLIST_IOS_GENERATOR_CASE_FILTER-} ]] &&
    [[ $contract_case != *${SNAPLIST_IOS_GENERATOR_CASE_FILTER}* ]]
  then
    continue
  fi

  if $contract_case; then
    print -r -- "PASS ${contract_case}"
  else
    print -u2 -r -- "FAIL ${contract_case}"
    failures=$((failures + 1))
  fi
done

exit $failures

#!/usr/bin/env ruby
# Regenerates ios/Scripts/test-shards.json from the UI test sources under
# ios/SnapListUITests and a measured timing input (ios/Scripts/test-shard-timings.json).
#
# Adding a UI test:
#   1. Write the test method under ios/SnapListUITests.
#   2. Measure its wall-clock seconds and add it to
#      ios/Scripts/test-shard-timings.json, under selector_observed_seconds,
#      keyed by "SnapListUITests/<Class>/<method>". A selector this generator
#      discovers without a timing is a hard error naming it — there is no
#      default or zero.
#   3. Run: ruby ios/Scripts/generate-test-shards.rb ios/Scripts/test-shard-timings.json
#   4. Commit the regenerated ios/Scripts/test-shards.json.
#
# Usage: generate-test-shards.rb timings.json [repository-root] [output-path]
#
# This file must never require, call, or otherwise share the packing
# implementation with validate-test-shards.rb. The validator is an
# independent re-derivation, so a wrong generator cannot produce a file that
# wrongly validates.

require "json"

timings_path = File.expand_path(ARGV.fetch(0) do
  abort "usage: generate-test-shards.rb timings.json [repository-root] [output-path]"
end)
abort "too many arguments" if ARGV.length > 3

repository_root = File.expand_path(
  ARGV.fetch(1, File.expand_path("../..", __dir__))
)
output_path = File.expand_path(
  ARGV.fetch(2, File.expand_path("../test-shards.json", __dir__))
)

begin
  timings = JSON.parse(File.read(timings_path))
rescue JSON::ParserError, Errno::ENOENT => error
  abort "invalid test shard timing input: #{error.message}"
end

discovered_ui_selectors = []
Dir.glob(
  File.join(repository_root, "ios/SnapListUITests/**/*.swift")
).sort.each do |test_file|
  current_test_class = nil

  File.foreach(test_file) do |line|
    class_match = line.match(
      /^\s*(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*XCTestCase\b/
    )
    current_test_class = class_match[1] if class_match

    method_match = line.match(
      /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:override\s+)?func\s+(test[A-Za-z0-9_]+)\s*\(/
    )
    next unless method_match

    abort "test method found outside an XCTestCase in #{test_file}" unless current_test_class

    discovered_ui_selectors <<
      "SnapListUITests/#{current_test_class}/#{method_match[1]}"
  end
end

duplicated_discovered_selectors = discovered_ui_selectors
  .group_by(&:itself)
  .select { |_selector, occurrences| occurrences.length > 1 }
  .keys
unless duplicated_discovered_selectors.empty?
  abort(
    "duplicated discovered UI test selectors: " \
      "#{duplicated_discovered_selectors.sort.join(", ")}"
  )
end

ui_shard_count = timings.fetch("ui_shard_count") do
  abort "test shard timing input must declare ui_shard_count"
end
unless ui_shard_count.is_a?(Integer) && ui_shard_count.positive?
  abort "test shard timing input ui_shard_count must be a positive integer"
end

execution_model = timings.fetch("execution_model") do
  abort "test shard timing input must declare execution_model"
end

baseline_provenance = timings.fetch("baseline_provenance") do
  abort "test shard timing input must declare baseline_provenance"
end
%w[
  run_id
  head_sha
  merged_tree_sha
  measured_layout_ui_shard_count
  xcode_version
  xcode_build
  unit_test_count
  source_ui_shard_suite_seconds
].each do |key|
  abort "test shard timing input baseline_provenance must define #{key}" unless baseline_provenance.key?(key)
end

selector_observed_seconds = timings.fetch("selector_observed_seconds") do
  abort "test shard timing input must define selector_observed_seconds"
end
unless selector_observed_seconds.is_a?(Hash)
  abort "test shard timing input selector_observed_seconds must be an object"
end

# A missing timing is a hard error, never a default or a zero: a fabricated
# number would silently mispredict a shard's wall clock instead of forcing
# whoever added the test to measure it.
missing_timings = discovered_ui_selectors.reject { |selector| selector_observed_seconds.key?(selector) }
unless missing_timings.empty?
  abort "missing timing for discovered selector(s): #{missing_timings.sort.join(", ")}"
end

packed_seconds = discovered_ui_selectors.each_with_object({}) do |selector, memo|
  memo[selector] = selector_observed_seconds.fetch(selector)
end.sort.to_h

balanced_shards = Array.new(ui_shard_count) do
  { observed_seconds: 0.0, selectors: [] }
end
packed_seconds
  .sort_by { |selector, seconds| [-seconds, selector] }
  .each do |selector, seconds|
    shard_index = balanced_shards.each_index.min_by do |index|
      [balanced_shards[index].fetch(:observed_seconds), index]
    end
    balanced_shards.fetch(shard_index).fetch(:selectors) << selector
    balanced_shards.fetch(shard_index)[:observed_seconds] += seconds
  end

shards = { "unit" => ["SnapListTests"] }
balanced_shards.each_with_index do |balanced_shard, index|
  shards["ui-#{index + 1}"] = balanced_shard.fetch(:selectors).sort
end

balanced_ui_shard_observed_seconds = {}
balanced_shards.each_with_index do |balanced_shard, index|
  balanced_ui_shard_observed_seconds["ui-#{index + 1}"] = balanced_shard.fetch(:observed_seconds).round(3)
end

inventory = {
  "schema_version" => 2,
  "ui_shard_count" => ui_shard_count,
  "execution_model" => execution_model,
  "shards" => shards,
  "baseline" => {
    "run_id" => baseline_provenance.fetch("run_id"),
    "head_sha" => baseline_provenance.fetch("head_sha"),
    "merged_tree_sha" => baseline_provenance.fetch("merged_tree_sha"),
    "measured_layout_ui_shard_count" => baseline_provenance.fetch("measured_layout_ui_shard_count"),
    "xcode_version" => baseline_provenance.fetch("xcode_version"),
    "xcode_build" => baseline_provenance.fetch("xcode_build"),
    "unit_test_count" => baseline_provenance.fetch("unit_test_count"),
    "ui_test_count" => discovered_ui_selectors.length,
    "source_ui_shard_suite_seconds" => baseline_provenance.fetch("source_ui_shard_suite_seconds"),
    "selector_seconds_total" => packed_seconds.values.sum.round(3),
    "balanced_ui_shard_observed_seconds" => balanced_ui_shard_observed_seconds,
    "selector_observed_seconds" => packed_seconds,
  },
}

File.write(output_path, JSON.pretty_generate(inventory) + "\n")

puts(
  "wrote #{output_path}: #{discovered_ui_selectors.length} UI selectors " \
    "across #{ui_shard_count} timing-balanced UI shards"
)

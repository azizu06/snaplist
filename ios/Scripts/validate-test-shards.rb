#!/usr/bin/env ruby

require "json"

inventory_path = File.expand_path(ARGV.fetch(0) do
  abort "usage: validate-test-shards.rb inventory.json [repository-root]"
end)
abort "too many arguments" if ARGV.length > 2

repository_root = File.expand_path(
  ARGV.fetch(1, File.expand_path("../..", __dir__))
)

begin
  inventory = JSON.parse(File.read(inventory_path))
rescue JSON::ParserError, Errno::ENOENT => error
  abort "invalid test shard inventory: #{error.message}"
end

abort "test shard inventory schema_version must be 2" unless inventory["schema_version"] == 2

ui_shard_count = inventory.fetch("ui_shard_count") do
  abort "test shard inventory must declare ui_shard_count"
end
unless ui_shard_count.is_a?(Integer) && ui_shard_count.positive?
  abort "test shard inventory ui_shard_count must be a positive integer"
end

shards = inventory.fetch("shards") do
  abort "test shard inventory must define shards"
end
expected_shards = ["unit"] + (1..ui_shard_count).map { |index| "ui-#{index}" }
unless shards.keys.sort == expected_shards.sort
  abort "test shard inventory must define exactly: #{expected_shards.join(", ")}"
end

selectors_by_shard = shards.transform_values do |selectors|
  unless selectors.is_a?(Array) && selectors.all? { |selector| selector.is_a?(String) }
    abort "every test shard must contain an array of selectors"
  end

  selectors
end

unless selectors_by_shard.fetch("unit") == ["SnapListTests"]
  abort "unit shard must own the complete SnapListTests target"
end

empty_ui_shards = selectors_by_shard
  .select { |shard, selectors| shard.start_with?("ui-") && selectors.empty? }
  .keys
unless empty_ui_shards.empty?
  abort "UI test shards must be nonempty: #{empty_ui_shards.sort.join(", ")}"
end

ui_selectors = selectors_by_shard
  .select { |shard, _selectors| shard.start_with?("ui-") }
  .values
  .flatten

selector_pattern = %r{\ASnapListUITests/[A-Za-z_][A-Za-z0-9_]*/test[A-Za-z0-9_]+\z}
invalid_selectors = ui_selectors.reject { |selector| selector.match?(selector_pattern) }
unless invalid_selectors.empty?
  abort "invalid UI test selectors: #{invalid_selectors.sort.join(", ")}"
end

duplicated_selectors = ui_selectors
  .group_by(&:itself)
  .select { |_selector, occurrences| occurrences.length > 1 }
  .keys
unless duplicated_selectors.empty?
  abort "duplicated UI test selectors: #{duplicated_selectors.sort.join(", ")}"
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

missing_selectors = discovered_ui_selectors - ui_selectors
unexpected_selectors = ui_selectors - discovered_ui_selectors

unless missing_selectors.empty?
  abort "unassigned UI test selectors: #{missing_selectors.sort.join(", ")}"
end

unless unexpected_selectors.empty?
  abort "unknown UI test selectors: #{unexpected_selectors.sort.join(", ")}"
end

baseline = inventory.fetch("baseline") do
  abort "test shard inventory must define baseline timing evidence"
end
# Selector time is a property of the test, not of how the tests were divided,
# so a measurement taken under one layout stays valid under another. The
# layout it was taken under does not, and a baseline that records a wall clock
# without recording which split produced it invites reading a stale number as
# a claim about the current one. Name the split instead; the wall clock the
# current split has to meet lives once, in shard-wall-clock-budget-minutes.
measured_layout_ui_shard_count = baseline.fetch("measured_layout_ui_shard_count") do
  abort "test shard inventory baseline must name the UI shard count it was measured under"
end
unless measured_layout_ui_shard_count.is_a?(Integer) && measured_layout_ui_shard_count.positive?
  abort "baseline measured_layout_ui_shard_count must be a positive integer"
end
if baseline.key?("required_pr_wall_clock")
  abort "baseline must not restate a wall-clock budget; shard-wall-clock-budget-minutes owns it"
end

selector_observed_seconds = baseline.fetch("selector_observed_seconds") do
  abort "test shard inventory baseline must define selector_observed_seconds"
end
unless selector_observed_seconds.is_a?(Hash) &&
  selector_observed_seconds.all? do |selector, seconds|
    selector.is_a?(String) && seconds.is_a?(Numeric) && seconds.finite? && seconds >= 0
  end
  abort "every selector timing must be a finite non-negative number"
end

missing_timings = discovered_ui_selectors - selector_observed_seconds.keys
unexpected_timings = selector_observed_seconds.keys - discovered_ui_selectors
unless missing_timings.empty?
  abort "missing UI selector timings: #{missing_timings.sort.join(", ")}"
end
unless unexpected_timings.empty?
  abort "unknown UI selector timings: #{unexpected_timings.sort.join(", ")}"
end

balanced_shards = Array.new(ui_shard_count) do
  { observed_seconds: 0.0, selectors: [] }
end
selector_observed_seconds
  .sort_by { |selector, seconds| [-seconds, selector] }
  .each do |selector, seconds|
    shard_index = balanced_shards.each_index.min_by do |index|
      [balanced_shards[index].fetch(:observed_seconds), index]
    end
    balanced_shards.fetch(shard_index).fetch(:selectors) << selector
    balanced_shards.fetch(shard_index)[:observed_seconds] += seconds
  end

balanced_shards.each_with_index do |balanced_shard, index|
  shard_name = "ui-#{index + 1}"
  actual_selectors = selectors_by_shard.fetch(shard_name).sort
  expected_selectors = balanced_shard.fetch(:selectors).sort
  next if actual_selectors == expected_selectors

  abort "#{shard_name} does not match deterministic timing balance"
end

unless baseline["ui_test_count"] == discovered_ui_selectors.length
  abort "baseline ui_test_count does not match discovered UI selectors"
end

selector_seconds_total = baseline["selector_seconds_total"]
calculated_selector_seconds_total = selector_observed_seconds.values.sum
unless selector_seconds_total.is_a?(Numeric) &&
  selector_seconds_total.finite? &&
  (selector_seconds_total - calculated_selector_seconds_total).abs <= 0.0005
  abort "baseline selector_seconds_total does not match selector timings"
end

balanced_ui_shard_observed_seconds = baseline["balanced_ui_shard_observed_seconds"]
unless balanced_ui_shard_observed_seconds.is_a?(Hash) &&
  balanced_ui_shard_observed_seconds.keys.sort == expected_shards.drop(1).sort
  abort "baseline balanced UI shard timing summary does not match declared shards"
end

balanced_shards.each_with_index do |balanced_shard, index|
  shard_name = "ui-#{index + 1}"
  declared_seconds = balanced_ui_shard_observed_seconds.fetch(shard_name)
  calculated_seconds = balanced_shard.fetch(:observed_seconds)
  unless declared_seconds.is_a?(Numeric) &&
    declared_seconds.finite? &&
    (declared_seconds - calculated_seconds).abs <= 0.0005
    abort "baseline #{shard_name} timing summary does not match selector timings"
  end
end

puts(
  "PASS test shard inventory: SnapListTests target and " \
    "#{ui_selectors.length} UI selectors assigned exactly once across " \
    "#{ui_shard_count} timing-balanced UI shards"
)

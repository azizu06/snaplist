#!/usr/bin/env ruby

require "json"

inventory_path = File.expand_path(ARGV.fetch(0) do
  abort "usage: validate-test-shards.rb [inventory.json]"
end)
repository_root = File.expand_path("../..", __dir__)

begin
  inventory = JSON.parse(File.read(inventory_path))
rescue JSON::ParserError, Errno::ENOENT => error
  abort "invalid test shard inventory: #{error.message}"
end

abort "test shard inventory schema_version must be 1" unless inventory["schema_version"] == 1

shards = inventory.fetch("shards") do
  abort "test shard inventory must define shards"
end
expected_shards = %w[unit ui-1 ui-2]
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
Dir.glob(File.join(repository_root, "ios/SnapListUITests/*.swift")).sort.each do |test_file|
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

puts(
  "PASS test shard inventory: SnapListTests target and " \
    "#{ui_selectors.length} UI selectors assigned exactly once"
)

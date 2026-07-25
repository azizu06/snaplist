#!/usr/bin/env ruby

require "strscan"
require "yaml"

class SymbolicText
  Variable = Struct.new(:name)

  attr_reader :parts

  def self.literal(value)
    new([value.to_s])
  end

  def self.variable(name)
    new([Variable.new(name)])
  end

  def initialize(parts)
    @parts = parts.each_with_object([]) do |part, normalized|
      next if part == ""

      if part.is_a?(String) && normalized.last.is_a?(String)
        normalized[-1] += part
      else
        normalized << part
      end
    end
  end

  def +(other)
    SymbolicText.new(parts + SymbolicText.coerce(other).parts)
  end

  def replace_literal(needle, replacement)
    replacement_parts = SymbolicText.coerce(replacement).parts
    replaced = parts.flat_map do |part|
      next [part] unless part.is_a?(String)

      replace_in_string(part, needle, replacement_parts)
    end

    SymbolicText.new(replaced)
  end

  def empty?
    parts.empty?
  end

  def ==(other)
    other.is_a?(SymbolicText) && parts == other.parts
  end

  def self.coerce(value)
    value.is_a?(SymbolicText) ? value : literal(value)
  end

  private

  def replace_in_string(value, needle, replacement_parts)
    output = []
    cursor = 0

    while (match = value.index(needle, cursor))
      output << value[cursor...match]
      output.concat(replacement_parts)
      cursor = match + needle.length
    end

    output << value[cursor..-1]
    output
  end
end

class DeferredBoolean
end

class GitHubExpressionParser
  Token = Struct.new(:type, :value)

  def initialize(source, context)
    @tokens = tokenize(source)
    @context = context
    @position = 0
  end

  def parse
    value = parse_or
    expect(:end)
    value
  end

  private

  def tokenize(source)
    scanner = StringScanner.new(source)
    tokens = []

    until scanner.eos?
      scanner.skip(/[[:space:]]+/)
      break if scanner.eos?

      token =
        if scanner.scan(/\|\|/)
          Token.new(:or)
        elsif scanner.scan(/&&/)
          Token.new(:and)
        elsif scanner.scan(/==/)
          Token.new(:equal)
        elsif scanner.scan(/\(/)
          Token.new(:left_parenthesis)
        elsif scanner.scan(/\)/)
          Token.new(:right_parenthesis)
        elsif scanner.scan(/,/)
          Token.new(:comma)
        elsif (string = scanner.scan(/'(?:[^']|'')*'/))
          Token.new(:string, string[1...-1].gsub("''", "'"))
        elsif (identifier = scanner.scan(/[A-Za-z_][A-Za-z0-9_.]*/))
          Token.new(:identifier, identifier)
        end

      raise "Unsupported GitHub expression near #{scanner.rest.inspect}" unless token

      tokens << token
    end

    tokens << Token.new(:end)
  end

  def parse_or
    value = parse_and

    while accept(:or)
      fallback = parse_and
      value = truthy?(value) ? value : fallback
    end

    value
  end

  def parse_and
    value = parse_equality

    while accept(:and)
      consequent = parse_equality
      value = truthy?(value) ? consequent : value
    end

    value
  end

  def parse_equality
    value = parse_primary

    value = compare(value, parse_primary) while accept(:equal)

    value
  end

  def parse_primary
    if accept(:left_parenthesis)
      value = parse_or
      expect(:right_parenthesis)
      return value
    end

    token = current_token

    case token.type
    when :string
      advance
      token.value
    when :identifier
      advance
      accept(:left_parenthesis) ? parse_function(token.value) : fetch_context(token.value)
    else
      raise "Expected an expression value, got #{token.type}"
    end
  end

  def parse_function(name)
    arguments = []

    unless accept(:right_parenthesis)
      loop do
        arguments << parse_or
        break if accept(:right_parenthesis)

        expect(:comma)
      end
    end

    raise "Unsupported GitHub expression function #{name}" unless name == "format"
    raise "format requires a template" if arguments.empty?

    arguments.drop(1).each_with_index.reduce(SymbolicText.literal(arguments.first)) do |formatted, (argument, index)|
      formatted.replace_literal("{#{index}}", argument)
    end
  end

  def fetch_context(name)
    @context.fetch(name) { raise "Unsupported GitHub context value #{name}" }
  end

  def truthy?(value)
    raise "Concurrency branching cannot depend on a symbolic context value" if value.is_a?(DeferredBoolean)
    return !value.empty? if value.is_a?(SymbolicText)

    value != false && !value.nil? && value != "" && value != 0
  end

  def compare(left, right)
    return left == right unless left.is_a?(SymbolicText) || right.is_a?(SymbolicText)
    return left == right if left.is_a?(SymbolicText) && right.is_a?(SymbolicText)

    DeferredBoolean.new
  end

  def accept(type)
    return false unless current_token.type == type

    advance
    true
  end

  def expect(type)
    token = current_token
    raise "Expected #{type}, got #{token.type}" unless token.type == type

    advance
    token
  end

  def current_token
    @tokens.fetch(@position)
  end

  def advance
    @position += 1
  end
end

def evaluate_template(template, context)
  output = SymbolicText.literal("")
  cursor = 0

  while (expression = template.match(/\$\{\{(.*?)\}\}/m, cursor))
    output += template[cursor...expression.begin(0)]
    output += GitHubExpressionParser.new(expression[1], context).parse
    cursor = expression.end(0)
  end

  remainder = template[cursor..-1]
  raise "Unterminated GitHub expression" if remainder.include?("${{")

  output + remainder
end

def context(event_name:)
  {
    "github.workflow" => "iOS",
    "github.event_name" => event_name,
    "github.ref" => SymbolicText.variable("github.ref"),
    "github.run_id" => SymbolicText.variable("github.run_id")
  }
end

workflow = YAML.load_file(ARGV.fetch(0))
group = workflow.dig("concurrency", "group")
raise "concurrency.group must be an active string" unless group.is_a?(String)

automatic_expected = SymbolicText.literal("ios-iOS-") + SymbolicText.variable("github.ref")

["pull_request", "push"].each do |event_name|
  automatic_context = context(event_name: event_name)
  actual = evaluate_template(group, automatic_context)
  raise "automatic concurrency group must resolve through github.ref" unless actual == automatic_expected
end

manual_context = context(event_name: "workflow_dispatch")
manual_actual = evaluate_template(group, manual_context)
manual_expected = SymbolicText.literal("ios-iOS-dispatch-") + SymbolicText.variable("github.run_id")
raise "manual concurrency group must be scoped by github.run_id" unless manual_actual == manual_expected

#!/usr/bin/env ruby

require "strscan"
require "yaml"

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

    value = value == parse_primary while accept(:equal)

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

    arguments.drop(1).each_with_index.reduce(arguments.first.to_s) do |formatted, (argument, index)|
      formatted.gsub("{#{index}}", argument.to_s)
    end
  end

  def fetch_context(name)
    @context.fetch(name) { raise "Unsupported GitHub context value #{name}" }
  end

  def truthy?(value)
    value != false && !value.nil? && value != "" && value != 0
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
  output = +""
  cursor = 0

  while (expression = template.match(/\$\{\{(.*?)\}\}/m, cursor))
    output << template[cursor...expression.begin(0)]
    output << GitHubExpressionParser.new(expression[1], context).parse.to_s
    cursor = expression.end(0)
  end

  remainder = template[cursor..-1]
  raise "Unterminated GitHub expression" if remainder.include?("${{")

  output << remainder
end

def context(event_name:, ref:, run_id:)
  {
    "github.workflow" => "iOS",
    "github.event_name" => event_name,
    "github.ref" => ref,
    "github.run_id" => run_id
  }
end

workflow = YAML.load_file(ARGV.fetch(0))
group = workflow.dig("concurrency", "group")
raise "concurrency.group must be an active string" unless group.is_a?(String)

automatic_contexts = [
  context(event_name: "pull_request", ref: "refs/pull/42/merge", run_id: "700"),
  context(event_name: "push", ref: "refs/heads/main", run_id: "701")
]

automatic_contexts.each do |automatic_context|
  actual = evaluate_template(group, automatic_context)
  expected = "ios-iOS-#{automatic_context.fetch("github.ref")}"
  raise "automatic concurrency group must resolve through github.ref" unless actual == expected
end

["702", "703"].each do |run_id|
  manual_context = context(event_name: "workflow_dispatch", ref: "refs/heads/main", run_id: run_id)
  actual = evaluate_template(group, manual_context)
  expected = "ios-iOS-dispatch-#{run_id}"
  raise "manual concurrency group must be scoped by github.run_id" unless actual == expected
end

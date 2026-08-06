import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import { z } from "zod";
import { MODEL_FACING_SCHEMAS } from "./contracts";

/**
 * Model-facing JSON Schema contract (issues #691, #696).
 *
 * `generateObject` does not send Zod to the provider — it compiles the supplied schema
 * to JSON Schema first. OpenAI structured outputs then REJECT the request outright
 * (400, before any tokens) when that compiled schema uses a construct they do not
 * support. A Zod `record` compiles to `propertyNames`, which is exactly such a
 * construct, and it took down every production pipeline run on `LLM_PROVIDER=openai`:
 *
 *   Invalid schema for response_format 'response': In context=('properties',
 *   'itemSpecifics'), 'propertyNames' is not permitted.
 *
 * Strict mode enforces THREE rules on the compiled schema, and this guard checks all
 * three (#691 shipped the first two; #696 added the third after both remaining roles
 * were found still broken):
 *
 *   1. no `propertyNames` (no open-ended records);
 *   2. every object carries `additionalProperties: false`;
 *   3. every key in an object's `properties` also appears in its `required` — an
 *      OPTIONAL field is not permitted at all, and yields
 *      `'description' is required to be supplied and to be not null`.
 *
 * Rule 3 is why absence must live in the VALUE (a nullable field is required-with-null)
 * and never in the key's presence.
 *
 * These tests assert on the COMPILED schema — the same artifact the SDK sends — using
 * the SDK's own `zodSchema` compiler, so no live provider call is involved.
 *
 * EVERY rule carries a POSITIVE CONTROL proving it can still fail (#697 item 6). The
 * roles are all clean, so every role assertion passes whether or not the walk actually
 * matches anything — a rule that quietly stopped firing would look exactly like a
 * codebase with nothing wrong in it. Each control is a schema that MUST be reported,
 * and each was verified by disabling its rule and watching only that control die.
 */

/** JSON Schema constructs OpenAI structured outputs reject. */
interface SchemaViolation {
  path: string;
  reason: string;
}

type JsonSchemaNode = Record<string, unknown>;

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [entryPath]
      : [];
  });
}

function generateObjectCallSiteCounts(projectRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of productionTypeScriptFiles(path.join(projectRoot, "src"))) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
    const relativePath = path.relative(projectRoot, file).split(path.sep).join("/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "generateObject"
      ) {
        counts.set(relativePath, (counts.get(relativePath) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return counts;
}

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Positions holding ONE subschema. `items` may instead hold an ARRAY (draft-07's
 * positional/tuple form), which the walk accepts for every keyword here rather than
 * special-casing one.
 */
const SINGLE_SUBSCHEMA_KEYWORDS = [
  "items",
  "additionalItems",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
] as const;

/** Positions holding an ARRAY of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/**
 * Positions holding a MAP of name → subschema. `properties` is walked separately
 * because rule 3 has to cross-check each key against the node's own `required`.
 * `dependencies` may instead contain property-name arrays; `isNode` below ignores
 * those non-schema entries.
 */
const SUBSCHEMA_MAP_KEYWORDS = [
  "patternProperties",
  "dependencies",
  "$defs",
  "definitions",
] as const;

/**
 * Walk the compiled JSON Schema through SCHEMA positions only (so a property that
 * happens to be *named* `propertyNames` is not mistaken for the keyword) and collect
 * every construct OpenAI structured outputs refuse.
 *
 * COVERAGE (#697 item 7). Every position the draft-07 vocabulary can nest a subschema
 * in is walked: `properties`, the three keyword groups above, and the array form of
 * `items`. Most are unreachable from today's five roles — the SDK compiles Zod to
 * draft-07, where a tuple lands in array-form `items` rather than `prefixItems`, and
 * nothing in Zod compiles to `patternProperties`, `if`/`then`/`else`, `not`, or
 * `contains` at all. They are walked regardless, because a guard whose coverage
 * depends on compiler internals stops being a guard the moment those internals move.
 *
 * ONE position is deliberately NOT followed: the `$ref` string itself. Its target is
 * always a `$defs`/`definitions` entry in the same document (the SDK emits no external
 * references), and those entries are walked directly — so a violation inside a
 * referenced definition is reported at its definition path. Resolving refs would find
 * nothing new and would need cycle detection, since a recursive schema's definition
 * refers back to itself. The `$ref` control below proves the definition path fires.
 */
function collectViolations(
  node: unknown,
  path: string,
  violations: SchemaViolation[] = [],
): SchemaViolation[] {
  if (!isNode(node)) return violations;

  if ("propertyNames" in node) {
    // An open-ended record/dictionary: keys are unknown up front.
    violations.push({ path, reason: "'propertyNames' is not permitted" });
  }
  const properties = node.properties;
  if (node.type === "object" || isNode(properties)) {
    if (node.additionalProperties !== false) {
      violations.push({
        path,
        reason: `object requires additionalProperties: false (found ${JSON.stringify(
          node.additionalProperties,
        )})`,
      });
    }
  }

  if (isNode(properties)) {
    // Rule 3: strict mode has no notion of an optional field — every declared
    // property must be listed in `required`. A `.optional()` Zod field compiles
    // out of `required` and 400s the request (#696).
    const required = Array.isArray(node.required) ? node.required : [];
    for (const [key, child] of Object.entries(properties)) {
      if (!required.includes(key)) {
        violations.push({
          path,
          reason: `'${key}' is in properties but missing from required (optional fields are not permitted)`,
        });
      }
      collectViolations(child, `${path}.properties.${key}`, violations);
    }
  }
  for (const keyword of SINGLE_SUBSCHEMA_KEYWORDS) {
    const child = node[keyword];
    if (isNode(child)) collectViolations(child, `${path}.${keyword}`, violations);
    // Draft-07 also allows the ARRAY form of `items` (positional/tuple schemas):
    // zod compiles `z.tuple([...])` to `items: [ ... ]`. Skipping arrays here
    // hid a tuple's whole subtree from the walk.
    else if (Array.isArray(child)) {
      child.forEach((entry, index) =>
        collectViolations(entry, `${path}.${keyword}[${index}]`, violations),
      );
    }
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) =>
        collectViolations(branch, `${path}.${keyword}[${index}]`, violations),
      );
    }
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const entries = node[keyword];
    if (isNode(entries)) {
      for (const [name, entry] of Object.entries(entries)) {
        collectViolations(entry, `${path}.${keyword}.${name}`, violations);
      }
    }
  }

  return violations;
}

describe("every model-facing schema compiles to OpenAI-acceptable JSON Schema (#691, #696)", () => {
  for (const { role, schema, callSite } of MODEL_FACING_SCHEMAS) {
    it(`${role} @ ${callSite}: no record, no open object, no optional field survives compilation`, () => {
      // The SDK's own compiler — the exact JSON Schema `generateObject` sends.
      const compiled = zodSchema(schema).jsonSchema;
      const violations = collectViolations(compiled, role);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }

  it("registers every production generateObject call-site file and count", () => {
    // Source discovery makes an unregistered new call fail this test. It proves
    // call-site coverage, not that an entry names the schema the call actually uses.
    const registeredCounts = new Map<string, number>();
    for (const { callSite } of MODEL_FACING_SCHEMAS) {
      registeredCounts.set(callSite, (registeredCounts.get(callSite) ?? 0) + 1);
    }
    expect(generateObjectCallSiteCounts(process.cwd())).toEqual(registeredCounts);
  });

  it("flags a Zod record — the construct that broke production", () => {
    // Positive control. Without it, a walker that silently matched nothing would
    // report every role as clean forever.
    const compiled = zodSchema(
      z.object({ itemSpecifics: z.record(z.string(), z.string()) }),
    ).jsonSchema;
    expect(collectViolations(compiled, "control")).toContainEqual({
      path: "control.properties.itemSpecifics",
      reason: "'propertyNames' is not permitted",
    });
  });

  it("flags an optional field — the construct that broke export + pricingAgent", () => {
    // Positive control for rule 3, matching the record control above: an
    // assertion that silently stopped matching would otherwise report every
    // role as clean forever (exactly how #696 hid behind the #691 guard).
    const compiled = zodSchema(
      z.object({ description: z.string().optional() }),
    ).jsonSchema;
    expect(collectViolations(compiled, "control")).toContainEqual({
      path: "control",
      reason:
        "'description' is in properties but missing from required (optional fields are not permitted)",
    });
  });

  it("walks into the ARRAY form of `items` — a tuple must not hide its subtree", () => {
    // Positive control for the walk itself. `z.tuple([...])` compiles to draft-07's
    // positional `items: [ ... ]`, an ARRAY. A walker that only recursed into an
    // object-valued `items` reported zero violations for the whole tuple subtree,
    // so a future tuple-shaped model schema could ship an optional field unseen.
    const compiled = zodSchema(
      z.object({ pair: z.tuple([z.object({ a: z.string().optional() })]) }),
    ).jsonSchema;
    expect(collectViolations(compiled, "control")).toContainEqual({
      path: "control.properties.pair.items[0]",
      reason:
        "'a' is in properties but missing from required (optional fields are not permitted)",
    });
  });

  it("flags an object left OPEN — the rule with no control until now (#697)", () => {
    // Positive control for rule 2. It is HAND-BUILT rather than compiled from Zod
    // because no Zod schema can produce the violation today: the SDK's `zodSchema`
    // stamps `additionalProperties: false` onto every object node it emits, including
    // `z.looseObject` and `.catchall()`. That is exactly the fragility this control
    // exists for — the day the compiler stops stamping it, rule 2 becomes the thing
    // standing between us and a 400, and without a control proving the rule can fire
    // we would have no way to notice it had gone silent instead.
    const open = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    expect(collectViolations(open, "control")).toEqual([
      {
        path: "control",
        reason: "object requires additionalProperties: false (found undefined)",
      },
    ]);
  });

  it("walks the subschema positions no current role reaches (#697)", () => {
    // Coverage control for the WALK. None of these positions can be produced by the
    // SDK's compiler today — it emits draft-07, so `z.tuple()` becomes the array form
    // of `items` and never `prefixItems`, and nothing in Zod compiles to
    // `patternProperties`, `dependencies`, `if`/`then`/`else`, `not`, or `contains`. They are walked
    // anyway, and asserted here on hand-built nodes, because the alternative is a
    // guard whose coverage silently depends on compiler internals: a schema dialect
    // bump or a `z.custom()` carrying a raw JSON Schema would move a role's subtree
    // into a position the walk skipped, and the guard would still report clean.
    const open = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const positions: Array<[string, JsonSchemaNode]> = [
      ["prefixItems", { type: "array", prefixItems: [open] }],
      [
        "patternProperties",
        { type: "object", additionalProperties: false, patternProperties: { "^s_": open } },
      ],
      [
        "dependencies",
        {
          dependencies: {
            propertyList: ["a"],
            dependentSchema: {
              type: "object",
              propertyNames: { type: "string" },
              properties: { optional: { type: "string" } },
            },
          },
        },
      ],
      ["if", { if: open }],
      ["then", { then: open }],
      ["else", { else: open }],
      ["not", { not: open }],
      ["contains", { type: "array", contains: open }],
      ["additionalItems", { type: "array", additionalItems: open }],
    ];
    for (const [keyword, node] of positions) {
      const path =
        keyword === "prefixItems"
          ? "control.prefixItems[0]"
          : keyword === "patternProperties"
            ? "control.patternProperties.^s_"
            : keyword === "dependencies"
              ? "control.dependencies.dependentSchema"
            : `control.${keyword}`;
      const violations = collectViolations(node, "control");
      if (keyword === "dependencies") {
        expect(violations, "dependencies schema subtree was not walked").toEqual([
          { path, reason: "'propertyNames' is not permitted" },
          { path, reason: "object requires additionalProperties: false (found undefined)" },
          {
            path,
            reason:
              "'optional' is in properties but missing from required (optional fields are not permitted)",
          },
        ]);
        continue;
      }
      expect(violations, `${keyword} subtree was not walked`).toContainEqual({
        path,
        reason: "object requires additionalProperties: false (found undefined)",
      });
    }
  });

  it("reports a violation inside a $ref target, reached at its definition", () => {
    // `$ref` needs no dereferencing: a recursive role schema compiles to a `$ref`
    // plus a `definitions` entry, and the walk visits that entry DIRECTLY — so the
    // violation is found and reported at its definition path, once, however many
    // `$ref`s point at it. Walking through the `$ref` string instead would add
    // nothing and would have to guard against the reference cycle this shape creates.
    const Node: z.ZodType = z.lazy(() =>
      z.object({ child: Node.nullable(), label: z.string().optional() }),
    );
    const compiled = zodSchema(z.object({ root: Node })).jsonSchema;
    expect(collectViolations(compiled, "control")).toContainEqual({
      path: "control.definitions.__schema0",
      reason:
        "'label' is in properties but missing from required (optional fields are not permitted)",
    });
  });

  it("accepts a required-but-nullable field — absence expressed in the VALUE", () => {
    // The shape the fix reaches for: the key is always supplied (rule 3 holds)
    // and "I have no value" is said with `null`, not by omitting the key.
    const compiled = zodSchema(
      z.object({ description: z.string().nullable() }),
    ).jsonSchema;
    expect(collectViolations(compiled, "control")).toEqual([]);
  });
});

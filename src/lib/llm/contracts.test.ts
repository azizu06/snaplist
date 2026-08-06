import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import { z } from "zod";
import { ROLE_OUTPUT_SCHEMA } from "./contracts";

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
 */

/** JSON Schema constructs OpenAI structured outputs reject. */
interface SchemaViolation {
  path: string;
  reason: string;
}

type JsonSchemaNode = Record<string, unknown>;

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk the compiled JSON Schema through SCHEMA positions only (so a property that
 * happens to be *named* `propertyNames` is not mistaken for the keyword) and collect
 * every construct OpenAI structured outputs refuse.
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
  for (const keyword of ["items", "additionalProperties", "propertyNames"] as const) {
    const child = node[keyword];
    if (isNode(child)) collectViolations(child, `${path}.${keyword}`, violations);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) =>
        collectViolations(branch, `${path}.${keyword}[${index}]`, violations),
      );
    }
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    const defs = node[keyword];
    if (isNode(defs)) {
      for (const [name, def] of Object.entries(defs)) {
        collectViolations(def, `${path}.${keyword}.${name}`, violations);
      }
    }
  }

  return violations;
}

describe("LLM role output schemas compile to OpenAI-acceptable JSON Schema (#691, #696)", () => {
  const roles = Object.keys(ROLE_OUTPUT_SCHEMA) as Array<keyof typeof ROLE_OUTPUT_SCHEMA>;
  for (const role of roles) {
    it(`${role}: no record, no open object, no optional field survives compilation`, () => {
      const schema: z.ZodType = ROLE_OUTPUT_SCHEMA[role];
      // The SDK's own compiler — the exact JSON Schema `generateObject` sends.
      const compiled = zodSchema(schema).jsonSchema;
      const violations = collectViolations(compiled, role);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }

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

  it("accepts a required-but-nullable field — absence expressed in the VALUE", () => {
    // The shape the fix reaches for: the key is always supplied (rule 3 holds)
    // and "I have no value" is said with `null`, not by omitting the key.
    const compiled = zodSchema(
      z.object({ description: z.string().nullable() }),
    ).jsonSchema;
    expect(collectViolations(compiled, "control")).toEqual([]);
  });
});

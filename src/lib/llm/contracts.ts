import { z } from "zod";
import { visionResponseSchema } from "../vision/extract";
import { measurementResponseSchema } from "../vision/measurements";
import { ebayListingRawSchema } from "../listing/schema";
import { rawExportPacksSchema } from "../export/schema";
import { judgeScoresSchema } from "../eval/judge";
import { webCompListSchema } from "../pricing/providers/web-search";
import { retailFindingListSchema } from "../pricing/providers/depreciation";
import { llmPriceEstimateSchema } from "../pricing/providers/llm-only";
import type { LlmRole } from "./registry";

/**
 * Every MODEL-FACING output schema in the codebase (issues #55, #691, #696) —
 * one entry per `generateObject` CALL SITE, not per role.
 *
 * A role is a model-routing key, and several roles fan out to more than one call
 * site: `pricingAgent` drives three (web comps, retail findings, the llm-only
 * floor) and `vision` drives two (attribute extraction, garment measurements).
 * The first version of this file was `Record<LlmRole, z.ZodType>` — one schema
 * per role — which structurally could not see the other five. It reported
 * "pricingAgent: clean" while `retailFindingListSchema` still shipped an
 * `.optional()` field that 400s OpenAI strict mode (#696 round 2). Keyed by call
 * site, the guard's coverage now matches its name.
 *
 * Each `schema` must be the object the call site actually hands to
 * `generateObject` — NOT an equivalent-looking reconstruction. `pricingAgent`
 * used to rebuild `{ comps: [...] }` locally from the exported comp schema,
 * which is precisely how a call site drifts out from under this guard.
 *
 * `fixture: true` marks the schema a recorded response fixture
 * (`fixtures/<role>.<provider>.json`) is captured against. Exactly one entry per
 * fixture role carries it — `fixtures.test.ts` asserts that, so a second
 * fixture-bearing call site cannot be added to a role silently.
 *
 * IMPORTANT: this module imports the role modules, so it must NEVER be re-exported
 * from `src/lib/llm/index.ts` — the role modules import the registry barrel, and a
 * barrel→contracts→role-module edge would create an import cycle. Only the contract
 * tests (and a future record script) import this file directly.
 */
export interface ModelFacingSchema {
  /** The provider-routing role this call site resolves its model through. */
  role: LlmRole;
  /** The exact schema handed to `generateObject`. */
  schema: z.ZodType;
  /** `path:line` of the `generateObject` call, so a failure names the caller. */
  callSite: string;
  /** True for the schema this role's recorded fixtures are captured against. */
  fixture?: true;
}

export const MODEL_FACING_SCHEMAS: readonly ModelFacingSchema[] = [
  {
    role: "vision",
    schema: visionResponseSchema,
    callSite: "src/lib/vision/extract.ts:344",
    fixture: true,
  },
  {
    role: "vision",
    schema: measurementResponseSchema,
    callSite: "src/lib/vision/measurements.ts:647",
  },
  {
    role: "listing",
    schema: ebayListingRawSchema,
    callSite: "src/lib/listing/generate.ts:626",
    fixture: true,
  },
  {
    role: "export",
    schema: rawExportPacksSchema,
    callSite: "src/lib/export/generate.ts:842",
  },
  {
    role: "pricingAgent",
    schema: webCompListSchema,
    callSite: "src/lib/pricing/providers/web-search.ts:331",
    fixture: true,
  },
  {
    role: "pricingAgent",
    schema: retailFindingListSchema,
    callSite: "src/lib/pricing/providers/depreciation.ts:232",
  },
  {
    role: "pricingAgent",
    schema: llmPriceEstimateSchema,
    callSite: "src/lib/pricing/providers/llm-only.ts:103",
  },
  {
    role: "judge",
    schema: judgeScoresSchema,
    callSite: "src/lib/eval/judge.ts:195",
    fixture: true,
  },
];

/**
 * The schema a role's recorded fixtures replay against. Derived from the single
 * registry above so the fixture contract can never name a schema the strict-mode
 * guard does not also walk.
 */
export function fixtureSchemaForRole(role: LlmRole): z.ZodType | undefined {
  return MODEL_FACING_SCHEMAS.find((e) => e.role === role && e.fixture)?.schema;
}

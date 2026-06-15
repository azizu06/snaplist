import { z } from "zod";
import { visionResponseSchema } from "../vision/extract";
import { ebayListingRawSchema } from "../listing/schema";
import { rawExportPacksSchema } from "../export/schema";
import { judgeScoresSchema } from "../eval/judge";
import { buyerReplyRawSchema } from "../inbox/reply";
import { webCompSchema } from "../pricing/providers/web-search";
import type { LlmRole } from "./registry";

/**
 * Per-role OUTPUT contracts (issue #55). Each entry is the SAME Zod schema handed
 * to `generateObject` at that role's call site — so a recorded response from
 * EITHER provider must validate here. The cross-provider contract test asserts
 * exactly that, which is what makes "provider stays swappable" a checked claim and
 * not a hope: if Gemini's structured output drifts from a role's shape, the test
 * fails before it ever reaches the showcase on OpenAI (or vice-versa).
 *
 * The pricing agent returns `{ comps: WebComp[] }` (its `webCompListSchema` is an
 * internal const, so it's reconstructed here from the exported `webCompSchema`).
 *
 * IMPORTANT: this module imports the role modules, so it must NEVER be re-exported
 * from `src/lib/llm/index.ts` — the role modules import the registry barrel, and a
 * barrel→contracts→role-module edge would create an import cycle. Only the contract
 * test (and a future record script) import this file directly.
 */
const pricingAgentOutputSchema = z.object({ comps: z.array(webCompSchema) });

export const ROLE_OUTPUT_SCHEMA = {
  vision: visionResponseSchema,
  listing: ebayListingRawSchema,
  export: rawExportPacksSchema,
  pricingAgent: pricingAgentOutputSchema,
  judge: judgeScoresSchema,
  reply: buyerReplyRawSchema,
} satisfies Record<LlmRole, z.ZodType>;

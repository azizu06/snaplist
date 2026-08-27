import { describe, expect, it } from "vitest";
import { PIPELINE_PROGRESS_SELECT, pipelineProgressRunSchema } from "./row";

/**
 * `pipelineProgressRunSchema` gates every raw Supabase row before it reaches
 * the Trophy Wall projection (`home/projection.ts`); an unvalidated or
 * out-of-sync row would either throw past the seller-facing state mapping or
 * silently admit a stale/queue-leaking shape. Nothing exercised this schema
 * directly before this test — `home/projection.ts` only hits it indirectly
 * behind a live Supabase client.
 */

const VALID_ROW = {
  id: "5b1f7e2a-6b1e-4e8a-9c1a-1a2b3c4d5e6f",
  user_id: "user_123",
  item_id: "6c2f7e2a-6b1e-4e8a-9c1a-1a2b3c4d5e70",
  listing_id: null,
  status: "running",
  stage: "pricing",
  attempt_count: 1,
  max_attempts: 3,
  safe_failure_message: null,
  retention_cleaned_at: null,
  updated_at: "2026-08-27T12:00:00.000Z",
};

describe("pipelineProgressRunSchema", () => {
  it("accepts a well-formed row", () => {
    expect(pipelineProgressRunSchema.parse(VALID_ROW)).toEqual(VALID_ROW);
  });

  it("rejects a status outside the pipeline's own vocabulary", () => {
    expect(() =>
      pipelineProgressRunSchema.parse({ ...VALID_ROW, status: "processing" }),
    ).toThrow();
  });

  it("rejects a stage outside the pipeline's own vocabulary", () => {
    expect(() =>
      pipelineProgressRunSchema.parse({ ...VALID_ROW, stage: "unknown" }),
    ).toThrow();
  });

  it("rejects a negative attempt_count and a non-positive max_attempts", () => {
    expect(() =>
      pipelineProgressRunSchema.parse({ ...VALID_ROW, attempt_count: -1 }),
    ).toThrow();
    expect(() =>
      pipelineProgressRunSchema.parse({ ...VALID_ROW, max_attempts: 0 }),
    ).toThrow();
  });

  it("keeps PIPELINE_PROGRESS_SELECT exactly in sync with the schema's own keys", () => {
    // A column added to one but not the other either fails at parse time in
    // production (schema ahead of the select list) or silently drops data
    // the projection needs (select list ahead of the schema) — this pins
    // the two lists to the same set so drift fails here instead of live.
    const selectedColumns = PIPELINE_PROGRESS_SELECT.split(",").sort();
    const schemaKeys = Object.keys(pipelineProgressRunSchema.shape).sort();
    expect(selectedColumns).toEqual(schemaKeys);
  });
});

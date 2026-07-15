import { describe, expect, it } from "vitest";
import {
  PIPELINE_QUEUE_SCHEMA_VERSION,
  createPipelineQueueEnvelope,
  pipelineQueueEnvelopeSchema,
} from "./envelope";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

describe("pipeline queue envelope", () => {
  it("contains only the trusted run identifier and schema version", () => {
    expect(createPipelineQueueEnvelope(RUN_ID)).toEqual({
      run_id: RUN_ID,
      schema_version: PIPELINE_QUEUE_SCHEMA_VERSION,
    });
    expect(Object.keys(createPipelineQueueEnvelope(RUN_ID)).sort()).toEqual([
      "run_id",
      "schema_version",
    ]);
  });

  it("rejects unknown fields so tenant identity and seller data cannot enter the queue", () => {
    expect(() =>
      pipelineQueueEnvelopeSchema.parse({
        run_id: RUN_ID,
        schema_version: PIPELINE_QUEUE_SCHEMA_VERSION,
        user_id: "user_forged",
      }),
    ).toThrow();
    expect(() =>
      pipelineQueueEnvelopeSchema.parse({
        run_id: RUN_ID,
        schema_version: PIPELINE_QUEUE_SCHEMA_VERSION,
        signed_url: "https://example.invalid/private-photo",
      }),
    ).toThrow();
  });

  it("rejects malformed run ids and unsupported schema versions", () => {
    expect(() => createPipelineQueueEnvelope("not-a-uuid")).toThrow();
    expect(() =>
      pipelineQueueEnvelopeSchema.parse({ run_id: RUN_ID, schema_version: 2 }),
    ).toThrow();
  });
});

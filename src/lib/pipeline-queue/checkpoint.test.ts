import { describe, expect, it } from "vitest";
import {
  PIPELINE_CHECKPOINT_MAX_JSONB_BYTES,
  pipelineCheckpointJsonbByteLength,
  pipelineWorkerCheckpointSchema,
} from "./checkpoint";

function checkpointWithBytes(targetBytes: number) {
  const checkpoint = {
    identified: {
      attributes: { title: "" },
      model: "m",
    },
  };
  const baseBytes = pipelineCheckpointJsonbByteLength(checkpoint);
  checkpoint.identified.attributes.title = "x".repeat(targetBytes - baseBytes);
  expect(pipelineCheckpointJsonbByteLength(checkpoint)).toBe(targetBytes);
  return checkpoint;
}

describe("pipeline worker checkpoint contract", () => {
  it("matches the database JSONB byte ceiling at the exact boundary", () => {
    expect(
      pipelineWorkerCheckpointSchema.safeParse(
        checkpointWithBytes(PIPELINE_CHECKPOINT_MAX_JSONB_BYTES),
      ).success,
    ).toBe(true);
    expect(
      pipelineWorkerCheckpointSchema.safeParse(
        checkpointWithBytes(PIPELINE_CHECKPOINT_MAX_JSONB_BYTES + 1),
      ).success,
    ).toBe(false);
  });
});

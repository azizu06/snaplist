import { describe, expect, it, vi } from "vitest";
import {
  buildPipelineRecoveryHref,
  persistPipelineRecoveryHandle,
} from "./recovery";

describe("pipeline recovery handles", () => {
  it("builds one navigable batch handle for single and batch capture", () => {
    const batchId = "11111111-1111-4111-8111-111111111111";

    expect(buildPipelineRecoveryHref("/upload", batchId)).toBe(
      `/upload?batch=${batchId}`,
    );
    expect(buildPipelineRecoveryHref("/batch", batchId)).toBe(
      `/batch?batch=${batchId}`,
    );
  });

  it("persists the handle in browser history before enqueue starts", () => {
    const replaceState = vi.fn();
    const history = { state: { existing: true }, replaceState };

    persistPipelineRecoveryHandle(
      history,
      "/upload",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "/upload?batch=11111111-1111-4111-8111-111111111111",
    );
  });
});

import { describe, expect, it } from "vitest";
import { runMobileRuntimeSmoke } from "./smoke";

describe("mobile runtime smoke proof", () => {
  it("starts the Node API and performs one bounded claim through the PGMQ adapter", async () => {
    const result = await runMobileRuntimeSmoke();

    expect(result.ok).toBe(true);
    expect(result.healthStatus).toBe(200);
    expect(result.sessionStatus).toBe(200);
    expect(result.workerStatus).toBe(200);
    expect(result.claimed).toBe(0);
    expect(result.pgmqRpcCalls).toEqual([
      {
        functionName: "claim_pipeline_messages",
        args: { p_quantity: 1, p_visibility_timeout_seconds: 30 },
      },
    ]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.rssDeltaBytes).toBeGreaterThanOrEqual(0);
  });
});

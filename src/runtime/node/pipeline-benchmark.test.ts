import { describe, expect, it } from "vitest";
import { runOfflinePipelineBenchmark } from "./pipeline-benchmark";

describe("offline representative durable-pipeline benchmark", () => {
  it("measures a complete identifiers-only consume through three checkpoints and durable completion", async () => {
    const result = await runOfflinePipelineBenchmark({
      fixturePhotos: [
        new Uint8Array([0xff, 0xd8, 0xff, 0x01]),
        new Uint8Array([0xff, 0xd8, 0xff, 0x02]),
      ],
      iterations: 3,
      warmupIterations: 1,
    });

    expect(result.profile).toBe("offline-representative-pipeline");
    expect(result.providerCalls).toBe(0);
    expect(result.photoCount).toBe(2);
    expect(result.photoBytes).toBe(8);
    expect(result.iterations).toBe(3);
    expect(result.completedRuns).toBe(3);
    expect(result.checkpoints).toBe(9);
    expect(result.queueAcknowledgements).toBe(3);
    expect(result.wallMs.p50).toBeGreaterThan(0);
    expect(result.wallMs.p95).toBeGreaterThanOrEqual(result.wallMs.p50);
    expect(result.cpuMs.p95).toBeGreaterThan(0);
    expect(result.peakRssBytes).toBeGreaterThan(0);
  });
});

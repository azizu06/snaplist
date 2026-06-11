import { describe, it, expect } from "vitest";
import { logEvent, timed } from "./observability";

/**
 * The observability seam is exercised entirely through its injectables (sink +
 * clock): every assertion is over the EMITTED LINE — the external behavior log
 * consumers (grep/jq, a collector) actually see — never internals.
 */

/** Collecting sink + a deterministic clock advancing `stepMs` per call. */
function harness(stepMs = 0) {
  const lines: string[] = [];
  let t = 1_000_000;
  return {
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    opts: {
      sink: (line: string) => lines.push(line),
      now: () => {
        const current = t;
        t += stepMs;
        return current;
      },
    },
  };
}

describe("logEvent", () => {
  it("emits one JSON line with event, ISO timestamp, and fields", () => {
    const h = harness();
    logEvent("pipeline.persisted", { runId: "r1", confidence: 0.8 }, h.opts);

    expect(h.lines).toHaveLength(1);
    const [line] = h.parsed();
    expect(line).toMatchObject({
      event: "pipeline.persisted",
      ts: new Date(1_000_000).toISOString(),
      runId: "r1",
      confidence: 0.8,
    });
  });

  it("drops undefined fields instead of emitting null noise", () => {
    const h = harness();
    logEvent("e", { present: 1, absent: undefined }, h.opts);
    expect(h.parsed()[0]).not.toHaveProperty("absent");
  });
});

describe("timed", () => {
  it("returns the wrapped result and logs durationMs + ok: true", async () => {
    const h = harness(50);
    const result = await timed("pipeline.run", { runId: "r1" }, async () => 42, h.opts);

    expect(result).toBe(42);
    expect(h.parsed()[0]).toMatchObject({
      event: "pipeline.run",
      runId: "r1",
      durationMs: 50,
      ok: true,
    });
  });

  it("logs ok: false with the error message and RETHROWS on failure", async () => {
    const h = harness(50);
    await expect(
      timed("pipeline.run", { runId: "r1" }, async () => {
        throw new Error("vision call failed");
      }, h.opts),
    ).rejects.toThrow("vision call failed");

    expect(h.parsed()[0]).toMatchObject({
      event: "pipeline.run",
      durationMs: 50,
      ok: false,
      error: "vision call failed",
    });
  });
});

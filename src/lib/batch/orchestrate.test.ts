import { describe, expect, it } from "vitest";
import {
  runBatch,
  runEntry,
  type BatchEntryState,
  type BatchRunOutcome,
} from "./orchestrate";

/**
 * Batch orchestration (issue #100) — the seam-level behavior the triage flow
 * depends on: bounded concurrency, quota short-circuit, and partial-failure
 * isolation. The runner is stubbed; no transport or pipeline here.
 */

const ok = (i: number): BatchRunOutcome => ({
  ok: true,
  itemId: `item-${i}`,
  listingId: `listing-${i}`,
  listingStatus: i % 2 === 0 ? "draft" : "queued",
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runBatch", () => {
  it("runs every entry and reports done states in input order", async () => {
    const calls: number[] = [];
    const states = await runBatch(4, async (i) => {
      calls.push(i);
      return ok(i);
    });
    expect(calls.sort()).toEqual([0, 1, 2, 3]);
    expect(states.map((s) => s.phase)).toEqual(["done", "done", "done", "done"]);
    expect(states[2]).toMatchObject({ itemId: "item-2", listingStatus: "draft" });
  });

  it("never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const states = await runBatch(
      7,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return ok(i);
      },
      { concurrency: 2 },
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(states).toHaveLength(7);
  });

  it("isolates a single failure: other entries still complete", async () => {
    const states = await runBatch(3, async (i) =>
      i === 1
        ? { ok: false, kind: "error", message: "pipeline blew up" }
        : ok(i),
    );
    expect(states[0].phase).toBe("done");
    expect(states[1]).toEqual({
      phase: "failed",
      kind: "error",
      message: "pipeline blew up",
    });
    expect(states[2].phase).toBe("done");
  });

  it("a terminal capacity outcome preserves its reason for every blocked entry", async () => {
    const calls: number[] = [];
    const message = "SnapList Pro is required to start another new item.";
    const states = await runBatch(
      5,
      async (i) => {
        calls.push(i);
        if (i === 1) return { ok: false, kind: "quota", message };
        return ok(i);
      },
      { concurrency: 1 },
    );
    // Sequential: 0 ran, 1 hit quota, 2–4 were never dispatched.
    expect(calls).toEqual([0, 1]);
    expect(states[0].phase).toBe("done");
    expect(states[1]).toEqual({ phase: "blocked", message });
    for (const s of states.slice(2)) {
      expect(s).toEqual({ phase: "blocked", message });
    }
  });

  it("lets an in-flight sibling finish when quota fires (its slot was already consumed)", async () => {
    const slow = deferred<BatchRunOutcome>();
    const statesPromise = runBatch(
      3,
      async (i) => {
        if (i === 0) return slow.promise; // in flight while 1 hits quota
        if (i === 1) return { ok: false, kind: "quota", message: "limit" };
        return ok(i);
      },
      { concurrency: 2 },
    );
    // Give worker B time to hit quota, then let the slow entry succeed.
    await new Promise((r) => setTimeout(r, 10));
    slow.resolve(ok(0));
    const states = await statesPromise;
    expect(states[0].phase).toBe("done");
    expect(states[1].phase).toBe("blocked");
    expect(states[2].phase).toBe("blocked"); // never started
  });

  it("emits live onUpdate transitions (waiting → running → terminal)", async () => {
    const seen: Array<[number, BatchEntryState["phase"]]> = [];
    await runBatch(
      2,
      async (i) => ok(i),
      { concurrency: 1, onUpdate: (i, s) => seen.push([i, s.phase]) },
    );
    expect(seen).toEqual([
      [0, "running"],
      [0, "done"],
      [1, "running"],
      [1, "done"],
    ]);
  });

  it("folds a thrown runner (transport bug) into a failed entry instead of rejecting", async () => {
    const states = await runBatch(2, async (i) => {
      if (i === 0) throw new Error("network");
      return ok(i);
    });
    expect(states[0].phase).toBe("failed");
    expect(states[1].phase).toBe("done");
  });

  it("handles an empty batch", async () => {
    const states = await runBatch(0, async () => {
      throw new Error("must not be called");
    });
    expect(states).toEqual([]);
  });
});

describe("runEntry", () => {
  it("passes through a resolved outcome", async () => {
    await expect(runEntry(async () => ok(3), 3)).resolves.toMatchObject({
      ok: true,
      itemId: "item-3",
    });
  });

  it("converts a throw into a retryable error outcome", async () => {
    const out = await runEntry(async () => {
      throw new Error("boom");
    }, 0);
    expect(out).toMatchObject({ ok: false, kind: "error" });
  });
});

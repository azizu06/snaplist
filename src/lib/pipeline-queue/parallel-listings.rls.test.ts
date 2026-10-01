import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { appendFileSync } from "node:fs";
import { startNodeMobileRuntime } from "@/runtime/node/server";
import type * as Harness from "@/test/parallel-listings-harness";
import { wakePipelineWorker } from "./wake";
import { POST as workerPost } from "@/app/api/internal/pipeline-worker/route";

const { after, createWorker } = vi.hoisted(() => ({ after: vi.fn(), createWorker: vi.fn() }));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after,
}));
vi.mock("@/lib/pipeline-queue/internal", () => ({ createInternalPipelineWorker: createWorker }));

// Opt-in: the helper additionally refuses every address except this test's
// dedicated loopback stack. Normal unit/CI runs do not connect to a database.
const enabled = process.env.SNAPLIST_PARALLEL_LISTINGS_TEST === "1";
let h: typeof Harness;
const used: Harness.Tenant[] = [];
const cfg = { identifyMs: 1500, priceMs: 2500, generateMs: 1500 };

function receipt(value: Record<string, unknown>) {
  const path = process.env.SNAPLIST_PARALLEL_LISTINGS_RECEIPTS;
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

describe.skipIf(!enabled)("parallel listings on isolated Supabase", () => {
  beforeAll(async () => { h = await import("@/test/parallel-listings-harness"); });
  afterAll(async () => { await h.cleanup(used); await h.pool.end(); });
  let singleItemWallMs = 0;

  async function verify(subs: Harness.Submitted[], rec: Harness.Recorder, redeliveries = 0) {
    const rows = await h.runRows(subs.map((sub) => sub.runId!));
    for (const sub of subs) {
      const row = rows.find((candidate) => candidate.id === sub.runId)!;
      expect(row).toMatchObject({
        user_id: sub.tenant.id, listing_user: sub.tenant.id,
        status: "succeeded", listings: "1", predictions: "1",
        title: `Fixture ${sub.marker}`,
      });
    }
    const ledger = await h.creditStates([...new Set(subs.map((sub) => sub.tenant.id))]);
    expect(ledger).toEqual([{ state: "settled", n: subs.length, distinct_runs: subs.length, settled_ts: subs.length, restored_ts: 0 }]);
    expect((await h.queueDepth()).queue_length).toBe(0);
    const usage = await h.usageRows(subs.map((sub) => sub.runId!));
    for (const sub of subs) {
      expect(usage.find((row) => row.run_id === sub.runId)).toMatchObject({
        model_calls: 3, input_tokens: String(3 * h.tokenSeed(sub.marker)),
      });
    }
    const claims = rec.events.filter((e) => e.kind === "queue.claim").flatMap((e) => e.ids as string[]);
    expect(new Set(claims).size).toBe(subs.length);
    expect(claims.length).toBe(subs.length + redeliveries);
  }

  it.each([1, 5, 10])("wakes %i simultaneous submissions without a scheduler tick", async (count) => {
    await h.purgeQueue();
    const tenants = await h.makeTenants(`wake${count}`, 2, { pro: true });
    used.push(...tenants);
    const submit = h.makeSubmissionHandler(tenants);
    const rec = new h.Recorder();
    const wakes: Promise<void>[] = [];
    const workers: Promise<void>[] = [];
    const dispatches: Array<{ claimed: number; responseMs: number }> = [];
    const callbacks: Array<() => Promise<void>> = [];
    let nextWorker = 0;
    after.mockImplementation((callback: () => Promise<void>) => callbacks.push(callback));
    createWorker.mockImplementation(() => h.makeWorker(`wake${nextWorker++}`, rec, cfg).worker);
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "local-test-worker";
    // Real loopback HTTP dispatch to a bearer-protected receiver, using the
    // production worker admission route and real worker composition. Only the
    // platform after() boundary is simulated; every background promise is tracked.
    const server = await startNodeMobileRuntime({
      host: "127.0.0.1", port: 0,
      handler: async (request) => {
        if (new URL(request.url).pathname !== "/api/internal/pipeline-worker"
            || request.headers.get("authorization") !== "Bearer local-test-worker") {
          return new Response(null, { status: 401 });
        }
        const start = rec.now();
        const response = await workerPost(request);
        expect(response.status).toBe(202);
        const callback = callbacks.shift()!;
        workers.push(new Promise<void>((resolve, reject) => {
          setImmediate(() => { callback().then(resolve, reject); });
        }));
        dispatches.push({ claimed: 0, responseMs: Math.round(rec.now() - start) });
        return response;
      },
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const handler = async (request: Request) => {
        const response = await submit(request);
        if (response.status === 202) wakes.push(Promise.resolve().then(() =>
          wakePipelineWorker({ origin, secret: "local-test-worker" })));
        return response;
      };
      const subs = await Promise.all(Array.from({ length: count }, (_, index) =>
        h.submitOne(handler, tenants[index % tenants.length], `wake${count}-${index}`)));
      expect(subs.every((sub) => sub.status === 202)).toBe(true);
      await Promise.all(wakes);
      const wakeWall = Math.round(rec.now());
      expect(dispatches).toHaveLength(count);
      expect(wakeWall).toBeLessThan(3000);
      expect(rec.events.some((event) => event.kind === "run.complete")).toBe(false);
      await Promise.all(workers);
      for (const [index, dispatch] of dispatches.entries()) {
        dispatch.claimed = (rec.events.find((event) => event.kind === "queue.claim"
          && event.worker === `wake${index}`)?.ids as string[]).length;
      }
      const intervals = [...h.runIntervals(rec.events).values()];
      const first = Math.min(...intervals.map(([start]) => start));
      const lastStart = Math.max(...intervals.map(([start]) => start));
      const wall = Math.round(rec.now());
      const lastClaim = Math.max(...rec.events.filter((event) =>
        event.kind === "queue.claim" && (event.ids as string[]).length > 0).map((event) => event.t));
      expect(lastClaim).toBeLessThan(3000);
      expect(lastStart).toBeLessThan(3000);
      expect(lastStart - first).toBeLessThan(2000);
      expect(h.maxOverlap(intervals)).toBe(count);
      if (count === 1) singleItemWallMs = wall;
      await verify(subs, rec);
      receipt({ scenario: "wake", count, lastClaimMs: lastClaim, lastStartMs: lastStart,
        wallMs: wall, overlap: h.maxOverlap(intervals), settledCredits: count, distinctClaims: count,
        wakeWallMs: wakeWall, dispatches, singleItemWallMs });
      if (count > 1) {
        // Keep wall time near the matched single-item run, allowing the same
        // 3s start window already required above. Host load is not a fixed SLA.
        expect(singleItemWallMs).toBeGreaterThan(0);
        expect(wall).toBeLessThan(singleItemWallMs + 3000);
      }
    } finally {
      await Promise.allSettled(workers);
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
      after.mockReset();
      createWorker.mockReset();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60_000);

  it("drains ten concurrently in one backup batch despite duplicate wakeups", async () => {
    await h.purgeQueue();
    const tenants = await h.makeTenants("backup", 1, { pro: true });
    used.push(...tenants);
    const submit = h.makeSubmissionHandler(tenants);
    const subs = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      h.submitOne(submit, tenants[0], `backup-${index}`)));
    expect(subs.every((sub) => sub.status === 202)).toBe(true);
    const rec = new h.Recorder();
    const summaries = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      h.makeWorker(`backup${index}`, rec, cfg).worker.consume()));
    const wall = Math.round(rec.now());
    expect(summaries.map((summary) => summary.claimed).sort((a, b) => a - b)).toEqual([0, 0, 10]);
    expect(summaries.reduce((total, summary) => total + summary.succeeded, 0)).toBe(10);
    expect(h.maxOverlap([...h.runIntervals(rec.events).values()])).toBe(10);
    expect(wall).toBeLessThan(8500);
    expect((await h.makeWorker("empty", rec, cfg).worker.consume()).claimed).toBe(0);
    await verify(subs, rec);
    receipt({ scenario: "backup-and-duplicates", count: 10, wallMs: wall, overlap: 10,
      settledCredits: 10, distinctClaims: 10, claimsPerInvocation: summaries.map((summary) => summary.claimed) });
  }, 60_000);

  it("retries one failed sibling with the same reserved credit", async () => {
    await h.purgeQueue();
    const tenants = await h.makeTenants("retry", 1, { pro: true });
    used.push(...tenants);
    const submit = h.makeSubmissionHandler(tenants);
    const subs = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      h.submitOne(submit, tenants[0], `retry-${index}`)));
    expect(subs.every((sub) => sub.status === 202)).toBe(true);
    const rec = new h.Recorder();
    const retryCfg = { ...cfg, failIdentifyTimes: new Map([["retry-2", 1]]) };
    const options = { retryBaseSeconds: 1, retryMaxSeconds: 1 };
    const first = await h.makeWorker("first", rec, retryCfg, options).worker.consume();
    expect(first).toEqual({ claimed: 5, succeeded: 4, retrying: 1, failed: 0, skipped: 0 });
    await h.sleep(1100);
    const retry = await h.makeWorker("retry", rec, retryCfg, options).worker.consume();
    expect(retry).toEqual({ claimed: 1, succeeded: 1, retrying: 0, failed: 0, skipped: 0 });
    const rows = await h.runRows(subs.map((sub) => sub.runId!));
    for (const sub of subs) {
      const expectedAttempts = sub.marker === "retry-2" ? 2 : 1;
      expect(rows.find((row) => row.id === sub.runId)?.attempt_count).toBe(expectedAttempts);
      expect(rec.identifyCalls.get(sub.marker)).toBe(expectedAttempts);
    }
    await verify(subs, rec, 1);
    receipt({ scenario: "retry", count: 5, settledCredits: 5, restoredCredits: 0,
      distinctClaims: 5, deliveries: 6, attempts: rows.map((row) => row.attempt_count) });
  }, 60_000);
});

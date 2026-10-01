/**
 * Local concurrency harness reused from the September 24 investigation.
 *
 * Real: Postgres + PGMQ + RLS + Storage on an isolated local Supabase stack, the real
 * mobile submission handler/service, the real PGMQ queue adapter, the real worker-store
 * RPC adapter, the real consumePipelineQueue + durable processor + lease fencing.
 * Fixture: only the four model-backed stages (identify/price/generate/assemble) — fixed
 * latency, no provider call, no network.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mintUserJwt, grantIncludedOfferDeviceClaim, cleanupClerkTestUsers } from "@/lib/supabase/test-users";
import { createMobileItemSubmissionHandler } from "@/lib/mobile-item-submission/http";
import { createConfiguredMobileItemSubmissionOperations } from "@/lib/mobile-item-submission/configured";
import { createSupabasePgmqPipelineQueue, type PipelineQueueRpcClient } from "@/lib/pipeline-queue/supabase-pgmq";
import { createSupabasePipelineWorkerStore, type PipelineWorkerRpcClient, type PipelineWorkerStore } from "@/lib/pipeline-queue/worker-store";
import { createPipelinePhotoCapability, createPipelineVoiceCapability, createPipelineWorker, type PipelineWorker } from "@/lib/pipeline-queue/composition";
import type { PipelineQueue } from "@/lib/pipeline-queue/queue";
import type { VisionPipelineStages } from "@/lib/vision";
import type { PipelineResult } from "@/lib/pipeline";
import type { SellerContextTranscriber } from "@/lib/llm/seller-context";
import { recordModelUsage } from "@/lib/provider-usage";

export const SUPABASE_URL = process.env.SUPABASE_URL!;
export const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
export const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
export const DB_URL = process.env.SUPABASE_TEST_DB_URL!;

// This helper purges a queue, so it must NEVER target a shared or hosted DB.
if (process.env.SNAPLIST_PARALLEL_LISTINGS_TEST !== "1"
    || SUPABASE_URL !== "http://127.0.0.1:56421"
    || DB_URL !== "postgresql://postgres:postgres@127.0.0.1:56422/postgres") {
  throw new Error("Parallel listings tests require their dedicated loopback stack.");
}
export const pool = new Pool({ connectionString: DB_URL, max: 6 });
export const admin: SupabaseClient = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const tokenSeed = (marker: string) => parseInt(createHash("sha256").update(marker).digest("hex").slice(0, 6), 16) % 9000 + 1000;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- recorder
export interface Ev { t: number; kind: string; worker?: string; marker?: string; [k: string]: unknown }
export class Recorder {
  t0 = performance.now();
  events: Ev[] = [];
  identifyCalls = new Map<string, number>();
  reset() { this.t0 = performance.now(); this.events = []; this.identifyCalls = new Map(); }
  now() { return performance.now() - this.t0; }
  add(kind: string, extra: Record<string, unknown> = {}) {
    this.events.push({ t: Math.round(this.now()), kind, ...extra } as Ev);
  }
}

// ---------------------------------------------------------------- fixtures
export function fakeJpeg(marker: string, ordinal: number, bytes: number): Uint8Array {
  const tag = new TextEncoder().encode(`MARK<${marker}>#${ordinal}`);
  const out = new Uint8Array(Math.max(bytes, tag.length + 6));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out.set(tag, 4);
  // deterministic non-trivial filler so bytes are not all zero
  for (let i = 4 + tag.length; i < out.length - 2; i += 1) out[i] = (i * 31 + ordinal) & 0xff;
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

export function multipartFor(marker: string, photos = 3, bytesPerPhoto = 300_000): FormData {
  const body = new FormData();
  for (let i = 0; i < photos; i += 1) {
    body.append("photo", new File([fakeJpeg(marker, i, bytesPerPhoto).buffer as ArrayBuffer], `p${i}.jpg`, { type: "image/jpeg" }));
  }
  body.append("costBasis", "12.50");
  return body;
}

export interface StageCfg {
  identifyMs: number;
  priceMs: number;
  generateMs: number;
  /** marker -> number of identify() calls that must throw before succeeding */
  failIdentifyTimes?: Map<string, number>;
  /** marker -> ms to hang inside identify on its FIRST invocation only (zombie worker). */
  hangFirstIdentifyMs?: Map<string, number>;
}

const PRICE: PipelineResult["price"] = {
  suggested: 149,
  range: { min: 130, max: 170 },
  confidence: 0.8,
  sources: [{ url: "https://www.ebay.com/itm/fixture-1", title: "fixture sold", kind: "sold-comp" }],
  evidence: [],
  tier: "llm-only",
} as unknown as PipelineResult["price"];

export function fixtureStagesFactory(rec: Recorder, cfg: StageCfg, workerLabel: () => string) {
  const identifyCalls = rec.identifyCalls;
  const factory = (input: { supabase: { storage: { from(bucket: string): { download(path: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }> } } } }): VisionPipelineStages => {
    const stages: VisionPipelineStages = {
      run: async () => { throw new Error("durable stage seam expected"); },
      identify: async ({ photos }) => {
        // Real Storage read of every private photo, like the real stage.
        let marker = "unknown";
        for (const [idx, path] of photos.entries()) {
          const { data, error } = await input.supabase.storage.from("photos").download(path);
          if (error || !data) throw new Error(`fixture photo download failed: ${error?.message}`);
          if (idx === 0) {
            const text = Buffer.from(await data.arrayBuffer()).toString("latin1");
            marker = /MARK<([^>]+)>/.exec(text)?.[1] ?? "unknown";
          }
        }
        const n = (identifyCalls.get(marker) ?? 0) + 1;
        identifyCalls.set(marker, n);
        rec.add("identify.start", { marker, worker: workerLabel(), call: n });
        const hang = n === 1 ? cfg.hangFirstIdentifyMs?.get(marker) : undefined;
        await sleep(hang ?? cfg.identifyMs);
        recordModelUsage({ role: "vision", provider: "openai", model: "fixture", inputTokens: tokenSeed(marker), outputTokens: 7 });
        const failTimes = cfg.failIdentifyTimes?.get(marker) ?? 0;
        if (n <= failTimes) {
          rec.add("identify.throw", { marker, worker: workerLabel(), call: n });
          throw new Error("fixture transient provider failure");
        }
        rec.add("identify.end", { marker, worker: workerLabel(), call: n });
        return {
          attributes: { brand: "Fixture", model: marker, condition: "good" },
          identification: { label: `Fixture ${marker}`, confident: true, evidence: 1 },
          model: "fixture-vision",
        };
      },
      price: async ({ attributes }) => {
        rec.add("price.start", { marker: attributes.model });
        await sleep(cfg.priceMs);
        recordModelUsage({ role: "vision", provider: "openai", model: "fixture", inputTokens: tokenSeed(String(attributes.model)), outputTokens: 7 });
        rec.add("price.end", { marker: attributes.model });
        return PRICE;
      },
      generate: async ({ attributes }) => {
        rec.add("generate.start", { marker: attributes.model });
        await sleep(cfg.generateMs);
        recordModelUsage({ role: "vision", provider: "openai", model: "fixture", inputTokens: tokenSeed(String(attributes.model)), outputTokens: 7 });
        rec.add("generate.end", { marker: attributes.model });
        return {
          copy: { platform: "ebay" as const, title: `Fixture ${attributes.model}`, description: `Item ${attributes.model}`, fields: {} },
          model: "fixture-listing",
        };
      },
      assemble: ({ identified, generated }) => ({
        attributes: identified.attributes,
        identification: identified.identification,
        price: PRICE,
        confidence: { score: 0.8, band: "high", autopilotEligible: false },
        listing: generated.copy,
        model: identified.model,
        listingModel: generated.model,
      }),
    };
    return stages;
  };
  return { factory, identifyCalls };
}

// ---------------------------------------------------------------- workers
const noTranscriber: SellerContextTranscriber = {
  transcriptionAttempt: { role: "sellerContext", provider: "openai", model: "unused", calls: 1, chargedUsd: null },
  async transcribe() { throw new Error("no voice in this scenario"); },
} as unknown as SellerContextTranscriber;

export function makeWorker(
  label: string,
  rec: Recorder,
  cfg: StageCfg,
  consumerOptions: { batchSize?: number; visibilityTimeoutSeconds?: number; retryBaseSeconds?: number; retryMaxSeconds?: number } = {},
): { worker: PipelineWorker; label: string } {
  // Every worker has its OWN supabase-js client (like every serverless invocation).
  const client = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const queueRpc: PipelineQueueRpcClient = {
    async rpc(fn, args) {
      const { data, error } = await client.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
  const workerRpc: PipelineWorkerRpcClient = {
    async rpc(fn, args) {
      const { data, error } = await client.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
  const rawQueue = createSupabasePgmqPipelineQueue(queueRpc);
  const rawRuns = createSupabasePipelineWorkerStore(workerRpc);
  const queue: PipelineQueue = {
    ...rawQueue,
    async claim(i) { const m = await rawQueue.claim(i); rec.add("queue.claim", { worker: label, ids: m.map((x) => x.id), readCounts: m.map((x) => x.readCount) }); return m; },
    async ack(id) { const r = await rawQueue.ack(id); rec.add("queue.ack", { worker: label, id, ok: r }); return r; },
    async defer(id, s) { const r = await rawQueue.defer(id, s); rec.add("queue.defer", { worker: label, id, seconds: s }); return r; },
  };
  const runs: PipelineWorkerStore = {
    ...rawRuns,
    async acquire(i) { const r = await rawRuns.acquire(i); rec.add("run.acquire", { worker: label, runId: i.runId, result: r.kind }); return r; },
    async complete(i) { try { const r = await rawRuns.complete(i); rec.add("run.complete", { worker: label, runId: i.runId, ok: true }); return r; } catch (e) { rec.add("run.complete", { worker: label, runId: i.runId, ok: false, err: String((e as Error).message).slice(0, 120) }); throw e; } },
    async failAttempt(i) { try { const r = await rawRuns.failAttempt(i); rec.add("run.fail", { worker: label, runId: i.runId, status: r.status, retryAfter: r.retryAfterSeconds }); return r; } catch (e) { rec.add("run.fail", { worker: label, runId: i.runId, ok: false, err: String((e as Error).message).slice(0, 120) }); throw e; } },
    async checkpoint(i) { try { return await rawRuns.checkpoint(i); } catch (e) { rec.add("run.checkpoint.rejected", { worker: label, runId: i.runId, stage: i.stage, err: String((e as Error).message).slice(0, 120) }); throw e; } },
  };
  const { factory } = fixtureStagesFactory(rec, cfg, () => label);
  return {
    label,
    worker: createPipelineWorker({
      capabilities: {
        queue,
        runs,
        photos: createPipelinePhotoCapability(client.storage),
        voice: createPipelineVoiceCapability(client.storage),
        guestRecovery: { async prepare() { return null; } } as never,
      },
      createStages: factory as never,
      transcriber: noTranscriber,
      consumerOptions,
    }),
  };
}

export async function consumeTimed(rec: Recorder, w: { worker: PipelineWorker; label: string }) {
  const start = rec.now();
  rec.add("consume.start", { worker: w.label });
  const zero = { claimed: 0, succeeded: 0, retrying: 0, failed: 0, skipped: 0 };
  try {
    const summary = await w.worker.consume();
    rec.add("consume.end", { worker: w.label, ...summary });
    return { label: w.label, start, end: rec.now(), summary, error: undefined as string | undefined };
  } catch (e) {
    const error = String((e as Error).message).slice(0, 160);
    rec.add("consume.rejected", { worker: w.label, error });
    return { label: w.label, start, end: rec.now(), summary: zero, error };
  }
}

// ---------------------------------------------------------------- submission
export interface Tenant { id: string; token: string }
export async function makeTenants(prefix: string, n: number, opts: { pro?: boolean } = {}): Promise<Tenant[]> {
  const stamp = Date.now();
  const tenants = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const id = `user_conc${prefix.replace(/[^A-Za-z0-9]/g, "")}x${i}x${stamp}`;
      return { id, token: await mintUserJwt(id) };
    }),
  );
  await Promise.all(tenants.map((t) => grantIncludedOfferDeviceClaim(admin, t.id)));
  if (opts.pro) {
    // Same audited RPC the operator-Pro allowlist uses (#1077): a Pro-equivalent allowance period.
    await Promise.all(tenants.map(async (t) => {
      const { error } = await admin.rpc("grant_operator_ai_item_allowance", { p_user_id: t.id, p_allowance: 10_000 });
      if (error) throw new Error(error.message);
    }));
  }
  return tenants;
}

export function makeSubmissionHandler(tenants: Tenant[]) {
  const byToken = new Map(tenants.map((t) => [t.token, t.id]));
  const submitter = createConfiguredMobileItemSubmissionOperations({
    supabaseURL: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
    secretKey: SECRET_KEY,
  });
  return createMobileItemSubmissionHandler({
    requestId: () => crypto.randomUUID(),
    itemSubmission: {
      async resolvePrincipal(token) {
        const userId = byToken.get(token);
        if (!userId) throw new Error("invalid test principal");
        return { kind: "clerk", userId, bearerToken: token };
      },
      submit: (input) => submitter.submit(input),
    },
  });
}

export interface Submitted { marker: string; tenant: Tenant; status: number; ms: number; runId?: string; itemId?: string; body?: unknown }
export async function submitOne(handler: (r: Request) => Promise<Response>, tenant: Tenant, marker: string, photos = 3, bytes = 300_000): Promise<Submitted> {
  const t = performance.now();
  const response = await handler(new Request("http://127.0.0.1:3001/v1/items/runs", {
    method: "POST",
    headers: { authorization: `Bearer ${tenant.token}`, "idempotency-key": crypto.randomUUID() },
    body: multipartFor(marker, photos, bytes),
  }));
  const ms = Math.round(performance.now() - t);
  const json = (await response.json().catch(() => null)) as { data?: { runId?: string; itemId?: string } } | null;
  return { marker, tenant, status: response.status, ms, runId: json?.data?.runId, itemId: json?.data?.itemId, body: response.status === 202 ? undefined : json };
}

// ---------------------------------------------------------------- analysis
export function maxOverlap(intervals: Array<[number, number]>): number {
  const pts: Array<[number, number]> = [];
  for (const [a, b] of intervals) { pts.push([a, 1], [b, -1]); }
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, max = 0;
  for (const [, d] of pts) { cur += d; max = Math.max(max, cur); }
  return max;
}

export function runIntervals(events: Ev[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const e of events) {
    if (!e.marker) continue;
    if (e.kind === "identify.start" && !out.has(e.marker)) out.set(e.marker, [e.t, e.t]);
    if (e.kind === "generate.end" && out.has(e.marker)) out.get(e.marker)![1] = e.t;
  }
  return out;
}

export async function runRows(runIds: string[]) {
  const { rows } = await pool.query(
    `select r.id, r.user_id, r.status, r.stage, r.attempt_count, r.failure_code, r.queue_message_id::text as msg,
            (select count(*) from public.listings l where l.run_id = r.id) as listings,
            (select count(*) from public.prediction_logs p where p.run_id = r.id) as predictions,
            (select l.title from public.listings l where l.run_id = r.id limit 1) as title,
            (select l.user_id from public.listings l where l.run_id = r.id limit 1) as listing_user,
            extract(epoch from (r.completed_at - r.created_at)) as e2e_s
       from public.pipeline_runs r where r.id = any($1::uuid[])`,
    [runIds],
  );
  return rows as Array<{ id: string; user_id: string; status: string; stage: string; attempt_count: number; failure_code: string | null; msg: string; listings: string; predictions: string; title: string | null; listing_user: string | null; e2e_s: string | null }>;
}

export async function queueDepth(): Promise<{ queue_length: number; oldest_msg_age_sec: number | null; total_messages: number }> {
  const { rows } = await pool.query(`select queue_length::int, oldest_msg_age_sec::int, total_messages::int from pgmq.metrics('pipeline_jobs')`);
  return rows[0];
}

export async function purgeQueue() { await pool.query(`select pgmq.purge_queue('pipeline_jobs')`); }

export async function cleanup(tenants: Tenant[]) {
  const ids = tenants.map((t) => t.id);
  const { rows } = await pool.query<{ path: string }>(
    `select name as path from storage.objects where bucket_id='photos' and split_part(name,'/',1) = any($1::text[])`, [ids]);
  if (rows.length) await admin.storage.from("photos").remove(rows.map((r) => r.path));
  await cleanupClerkTestUsers(admin, ids);
}

export function sha(s: string) { return createHash("sha256").update(s).digest("hex").slice(0, 8); }

export function pct(sorted: number[], p: number) { if (!sorted.length) return NaN; const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1); return sorted[i]; }

export async function creditStates(userIds: string[]) {
  const { rows } = await pool.query(
    `select state, count(*)::int as n, count(distinct pipeline_run_id)::int as distinct_runs, count(settled_at)::int as settled_ts, count(restored_at)::int as restored_ts
       from public.ai_item_credit_reservations where user_id = any($1::text[]) group by state order by state`, [userIds]);
  return rows as Array<{ state: string; n: number; distinct_runs: number; settled_ts: number; restored_ts: number }>;
}

/** Provider-usage rows persisted per run; used to prove AsyncLocalStorage isolation across concurrent runs in ONE process. */
export async function usageRows(runIds: string[]) {
  const { rows } = await pool.query(
    `select run_id, model_calls, input_tokens::bigint::text as input_tokens, output_tokens::bigint::text as output_tokens from public.pipeline_run_provider_usage where run_id = any($1::uuid[])`, [runIds]);
  return rows as Array<{ run_id: string; model_calls: number; input_tokens: string; output_tokens: string }>;
}


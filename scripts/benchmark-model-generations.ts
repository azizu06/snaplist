/** Opt-in, bounded screening of the existing public stage wrappers. No DB or marketplace calls. */
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { GOLD_SET, JUDGE_HUMAN_LABELS } from "../src/lib/eval/fixtures";
import { createCrossFamilyJudge, createHeuristicJudge, judgeAgreement } from "../src/lib/eval/judge";
import { createOpenAIVisionGenerate, extractItemAttributes } from "../src/lib/vision/extract";
import { createOpenAIListingGenerate, generateEbayListing } from "../src/lib/listing/generate";
import { createOpenAIExportPackGenerate, generateExportPacks, packsHallucinateAttributes } from "../src/lib/export/generate";
import { createOpenAICompExtractor } from "../src/lib/pricing/providers/web-search";
import { createVisionPipeline } from "../src/lib/vision/pipeline";
import { PriceRouter } from "../src/lib/pricing/router";
import { createLlmOnlyPricingProvider } from "../src/lib/pricing/providers/llm-only";
import { pipelineResultSchema } from "../src/lib/pipeline/types";
import { createBenchmarkBudget } from "./benchmark-model-budget";

const rates = {
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
} as const;
type Model = keyof typeof rates;
const models = Object.keys(rates) as Model[];
const stages = ["vision", "listing", "export", "pricingAgent", "judge"] as const;
type Stage = (typeof stages)[number];
const photoFixtures = [
  { path: "public/demo/reseller/airpods-max.webp", brand: "Apple", family: "AirPods Max" },
  { path: "public/demo/reseller/dualsense.webp", brand: "Sony", family: "DualSense" },
];
const LIMIT_USD = 1.20; // Leave >$0.75 from the observed $1.98 balance even after rounding.
const MAX_OUTPUT = 2_048;
// A deliberately conservative input reservation for one <=512px image plus the fixed prompts.
const INPUT_RESERVATION = 16_384;
const outputDir = "docs/benchmarks/model-generations/2026-10-01";

async function main() {
  const live = process.argv.includes("--live");
  const complete = process.argv.includes("--complete-listings");
  if (process.argv.slice(2).some(arg => arg !== "--live" && arg !== "--complete-listings")) throw new Error("Unknown flag");
  const prior = complete && live ? JSON.parse(await readFile(`${outputDir}/screening.json`, "utf8")) : undefined;
  if (live && !complete) {
    try { await readFile(`${outputDir}/screening.json`); throw new Error("Existing receipt; do not overwrite benchmark spend"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  if (prior?.completeListings?.length || prior?.unknownReservedUsd) throw new Error("Cannot repeat or resume uncertain paid outcomes");
  const plan = { models, stages, photoFixtures, fixturesPerStage: 2, maximumRequests: 40,
    limitUsd: LIMIT_USD, maxOutputTokens: MAX_OUTPUT, serviceTier: "default", completeListings: complete,
    reasoning: "provider default; role effort overrides explicitly set to default", externalSearchCalls: 0,
    databaseWrites: 0, live };
  if (!live) { console.log(JSON.stringify(plan, null, 2)); return; }
  process.env.OPENAI_API_KEY = execFileSync("security", ["find-generic-password", "-s",
    "snaplist-openai-benchmark", "-a", "benchmark", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  process.env.LLM_PROVIDER = "openai";
  // Preserve the historical comparison's omitted effort despite newer runtime defaults.
  for (const name of ["VISION_REASONING_EFFORT", "LISTING_REASONING_EFFORT",
    "EXPORT_PACK_REASONING_EFFORT", "PRICING_REASONING_EFFORT"]) {
    process.env[name] = "default";
  }
  const priorCost = prior?.measuredTokenCostUsd ?? 0;
  const budget = createBenchmarkBudget(LIMIT_USD - priorCost);
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = prior?.requests ?? [];
  const requestLimit = complete ? 64 : 40;
  const stageScope = new AsyncLocalStorage<Stage>();
  let activeStage: Stage = "vision";
  let fatalAccessError = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.openai.com/v1/chat/completions") throw new Error("Unexpected benchmark endpoint");
    if (typeof init?.body !== "string") throw new Error("Unexpected request shape");
    const body = JSON.parse(init.body);
    const model = body.model as Model;
    const rate = rates[model];
    if (!rate || fatalAccessError) throw new Error("Benchmark access unavailable");
    if (requests.length >= requestLimit) throw new Error("Benchmark request cap reached");
    const textCharacters = JSON.stringify(body, (key, value) =>
      key === "url" && typeof value === "string" && value.startsWith("data:image/") ? "[bounded image]" : value).length;
    if (textCharacters > 12_000) throw new Error("Benchmark input reservation exceeded");
    // No unbounded retry/request can spend beyond this fence. Failed/unknown outcomes retain reserve.
    const reservation = budget.reserve((INPUT_RESERVATION * rate.input + MAX_OUTPUT * rate.output) / 1e6);
    if (!reservation) throw new Error("Benchmark budget exhausted");
    delete body.max_tokens;
    body.max_completion_tokens = MAX_OUTPUT;
    body.service_tier = "default";
    const started = performance.now();
    const receipt: Record<string, unknown> = { stage: stageScope.getStore() ?? activeStage, model, status: null };
    requests.push(receipt);
    const response = await originalFetch(input, { ...init, body: JSON.stringify(body),
      signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000)]) });
    Object.assign(receipt, { status: response.status, wallMs: Math.round(performance.now() - started) });
    // Read ONLY usage/status into receipts; never request headers, prompts, provider errors, or keys.
    const data = await response.clone().json().catch(() => null);
    if (data?.usage) {
      const u = data.usage;
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      const cost = ((u.prompt_tokens - cached) * rate.input + cached * rate.cached + u.completion_tokens * rate.output) / 1e6;
      reservation.settle(cost);
      Object.assign(receipt, { inputTokens: u.prompt_tokens, cachedInputTokens: cached,
        outputTokens: u.completion_tokens, reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        costUsd: cost, finishReason: data.choices?.[0]?.finish_reason });
    } else if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      reservation.settle(0); // API refusal, before generation.
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) fatalAccessError = true;
    return response;
  };

  const photos = await Promise.all(photoFixtures.map(async fixture => {
    const original = await readFile(fixture.path);
    const data = await sharp(original).resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp().toBuffer();
    return { ...fixture, sha256: createHash("sha256").update(original).digest("hex"), data };
  }));
  const sony = GOLD_SET.find(item => item.id === "gold-electronics-sony-wh1000xm4")!;
  const cores = [sony.truth, JUDGE_HUMAN_LABELS[1].attributes];
  const samples: Array<Record<string, unknown>> = prior?.samples ?? [];
  const completeListings: Array<Record<string, unknown>> = [];
  await mkdir(outputDir, { recursive: true });
  const save = async () => writeFile(`${outputDir}/screening.json`, JSON.stringify({
    observedAt: new Date().toISOString(), sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    plan: prior?.plan ?? plan, completionPlan: complete ? { ...plan, maximumRequests: requestLimit } : undefined,
    benchmarkSourceSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    photoHashes: photos.map(({ path, sha256 }) => ({ path, sha256 })),
    measuredTokenCostUsd: priorCost + budget.chargedUsd(), unknownReservedUsd: budget.heldUsd(), requests, samples, completeListings,
    limits: ["Two fixed examples per stage; exploratory percentiles, not a p95 reliability claim.",
      "512px single photos; no multi-photo, seller voice, DB durability, or live search evidence.",
      "2048 completion-token cap includes reasoning; cap failures disqualify, never justify adoption.",
      "Complete candidates use the real pipeline with local photo downloads and LLM-only pricing. DB durability and live sold/web retrieval costs are not measured.",
      "Heuristic listing scores are screening only; human labels calibrate judge candidates."],
  }, null, 2) + "\n");
  try {
    if (complete) {
      for (let index = 0; index < photos.length; index++) {
        for (const model of index === 0 ? models : [...models].reverse()) {
          if (fatalAccessError) break;
          const photo = photos[index];
          const started = performance.now();
          const beforeCost = budget.chargedUsd();
          const beforeRequests = requests.length;
          const router = new PriceRouter([createLlmOnlyPricingProvider({ model })]);
          const pipeline = createVisionPipeline({
            supabase: { storage: { from: () => ({ download: async () => ({ data: new Blob([Uint8Array.from(photo.data)], { type: "image/webp" }), error: null }) }) } },
            extract: args => stageScope.run("vision", () => extractItemAttributes({ ...args, model, maxRetries: 0 })),
            priceItem: signal => stageScope.run("pricingAgent", () => router.price(signal)),
            generateListing: args => stageScope.run("listing", async () => {
              const result = await generateEbayListing({ ...args, model, maxRetries: 0, fewShot: { examples: [], matches: [] } });
              return { copy: result.copy, model: result.model };
            }),
          });
          let output: unknown;
          let error: string | undefined;
          try { output = pipelineResultSchema.parse(await pipeline.run({ photos: [photo.path] })); }
          catch (caught) { error = caught instanceof Error ? caught.name : "UnknownError"; }
          const result = { model, fixtureIndex: index, usableCandidate: error === undefined,
            wallMs: Math.round(performance.now() - started), modelCostUsd: budget.chargedUsd() - beforeCost,
            requestCount: requests.length - beforeRequests, output, error };
          completeListings.push(result);
          await save();
          console.log(JSON.stringify({ model, fixtureIndex: index, usableCandidate: result.usableCandidate,
            wallMs: result.wallMs, modelCostUsd: result.modelCostUsd, totalModelCostUsd: priorCost + budget.chargedUsd() }));
        }
      }
      return;
    }
    for (let index = 0; index < 2; index++) {
      for (const stage of stages) {
        for (const model of index === 0 ? models : [...models].reverse()) {
          if (fatalAccessError) break;
          activeStage = stage;
          const started = performance.now();
          const before = requests.length;
          let output: unknown;
          let quality: unknown;
          let error: string | undefined;
          try {
            const attributes = cores[index];
            if (stage === "vision") {
              const photo = photos[index];
              const raw = await createOpenAIVisionGenerate()({ model, images: [{ data: photo.data, mediaType: "image/webp" }], attempt: 0 });
              output = await extractItemAttributes({ model, images: [{ data: photo.data, mediaType: "image/webp" }], maxRetries: 0, generate: async () => raw });
              const attrs = (output as Awaited<ReturnType<typeof extractItemAttributes>>).attributes;
              quality = { identityCorrect: attrs.brand === photo.brand && attrs.model?.toLowerCase().includes(photo.family.toLowerCase()) };
            } else if (stage === "listing") {
              const fewShot = { examples: [], matches: [] };
              const raw = await createOpenAIListingGenerate()({ model, attributes, fewShot, attempt: 0 });
              const result = await generateEbayListing({ model, attributes, fewShot, maxRetries: 0, generate: async () => raw });
              output = { raw, listing: result.listing };
              quality = await createHeuristicJudge()({ attributes, listing: result.listing });
            } else if (stage === "export") {
              const raw = await createOpenAIExportPackGenerate()({ model, attributes, attempt: 0 });
              const result = await generateExportPacks({ model, attributes, price: 149, maxRetries: 0, generate: async () => raw });
              output = { raw, facebook: result.facebook.pack, mercari: result.mercari.pack, depop: result.depop.pack };
              quality = { rawGrounded: !packsHallucinateAttributes(raw, attributes) };
            } else if (stage === "pricingAgent") {
              const prefix = `fixture-${index}`;
              const results = [
                { url: `https://www.ebay.com/itm/${prefix}-1`, title: "Sony WH-1000XM4 — SOLD listing", snippet: "Sold for $178.00 on Jun 1" },
                { url: `https://www.ebay.com/itm/${prefix}-2`, title: "Sony WH-1000XM4 (Black) — SOLD", snippet: "Sold for $185.50" },
                { url: `https://www.mercari.com/us/item/${prefix}-3`, title: "Sony WH-1000XM4 used", snippet: "Asking $199.99" },
              ];
              const comps = await createOpenAICompExtractor(undefined, model)({ signal: sony.truth, query: "Sony WH-1000XM4 used", results });
              output = comps;
              quality = { exactExtraction: comps.length === 3 && results.every((hit, i) => comps.some(c => c.url === hit.url && c.price === [178, 185.5, 199.99][i] && c.kind === (i === 2 ? "asking" : "sold"))) };
            } else {
              const label = JUDGE_HUMAN_LABELS[index];
              const scores = await createCrossFamilyJudge({ genProvider: "google", modelId: model })({ attributes: label.attributes, listing: label.listing });
              output = scores;
              quality = judgeAgreement([scores], [label.human]);
            }
          } catch (caught) {
            error = caught instanceof Error ? caught.name : "UnknownError";
          }
          const sample = { stage, model, fixtureIndex: index, structuredPass: error === undefined,
            wallMs: Math.round(performance.now() - started), requestCount: requests.length - before,
            output, quality, error };
          samples.push(sample);
          await save();
          console.log(JSON.stringify({ stage, model, fixtureIndex: index, structuredPass: sample.structuredPass,
            requestCount: sample.requestCount, wallMs: sample.wallMs, measuredTokenCostUsd: budget.chargedUsd(), unknownReservedUsd: budget.heldUsd() }));
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    await save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Benchmark stopped; error details redacted."); process.exitCode = 1; });
}

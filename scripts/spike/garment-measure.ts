/**
 * Spike #104 — can a vision model measure a garment from a flat-lay photo?
 *
 * For each gold fixture (a real eBay listing whose seller stated measurements),
 * make ONE structured vision call through the repo's LLM layer and record the
 * model's measurement estimates. Scoring/reporting is a separate step (report.ts)
 * so model runs are cached in predictions.json and never re-spent on a re-score.
 *
 *   pnpm exec tsx scripts/spike/fetch-images.ts     # first: pull photos locally
 *   pnpm exec tsx scripts/spike/garment-measure.ts  # one Gemini call per fixture
 *   pnpm exec tsx scripts/spike/report.ts           # score + RESULTS.md
 *
 * Provider is PINNED to Google/Gemini (dev free tier) — this spike must not
 * spend OpenAI budget, so it doesn't trust ambient LLM_PROVIDER. Flags:
 *   --only <id>    run a single fixture (debugging)
 *   --limit <n>    run the first n fixtures
 *   --model <id>   override the model id (still Gemini)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateObject } from "ai";
import { resolveLanguageModel, resolveModelId } from "../../src/lib/llm";
import { loadEnvLocal, SPIKE_DIR } from "./env";
import {
  goldFixturesSchema,
  measurementResponseSchema,
  type GoldFixture,
  type PredictionRecord,
} from "./types";

const FIXTURES = path.join(SPIKE_DIR, "fixtures", "fixtures.json");
const IMAGES_DIR = path.join(SPIKE_DIR, "fixtures", "images");
const PREDICTIONS = path.join(SPIKE_DIR, "predictions.json");

/** Gemini free tier is RPM-limited; pause between calls instead of tripping 429s. */
const CALL_GAP_MS = 5_000;
/** One retry on a schema-invalid response (mirrors extract.ts's retry semantics). */
const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT =
  "You estimate the flat-lay measurements of a secondhand garment from a single photo, " +
  "the way a reseller would with a tape measure. First look for any object of KNOWN " +
  "physical size in the frame — a tape measure or ruler (read it directly where it " +
  "crosses the garment), a credit card (3.37in wide), letter paper (8.5x11in), a coin, " +
  "a phone. If one exists, derive a pixels-per-inch scale from it and measure the " +
  "garment against that scale; report those measurements with method=reference-scaled. " +
  "If NO known-size object is visible, estimate from garment-type proportions and any " +
  "visible size tag (e.g. a men's size-L tee is typically ~22in pit-to-pit), and report " +
  "method=prior-based. Only report measurements you can actually ground in the photo; " +
  "use the standard flat-lay conventions given in the schema (waist measured FLAT " +
  "across, not doubled). Be brutally honest in tolerance_in: a reference-scaled reading " +
  "might be +/-0.5in, a pure prior-based guess is often +/-2in or worse — say so.";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function measureOne(
  fixture: GoldFixture,
  modelId: string,
): Promise<PredictionRecord> {
  // Primary photo + any extras (tape close-ups / full flat-lay), capped at the
  // product's 4-image vision-call bound.
  const files = [
    `${fixture.id}.jpg`,
    ...(fixture.extra_image_urls ?? []).map((_, i) => `${fixture.id}-${i + 2}.jpg`),
  ].slice(0, 4);
  const paths = files.map((f) => path.join(IMAGES_DIR, f));
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return {
      fixtureId: fixture.id,
      model: modelId,
      ok: false,
      error: `image(s) missing locally (${missing.length}) — run fetch-images.ts first`,
    };
  }
  const images = paths.map((p) => readFileSync(p));

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const model = await resolveLanguageModel("vision", {
        provider: "google",
        modelId,
      });
      const { object } = await generateObject({
        model,
        schema: measurementResponseSchema,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  (attempt === 0
                    ? "Estimate this garment's flat-lay measurements in inches."
                    : "Your previous response was not schema-valid. Re-estimate, strictly matching the schema.") +
                  (images.length > 1
                    ? " All photos show the SAME garment (different angles or close-ups)."
                    : ""),
              },
              ...images.map((image) => ({
                type: "image" as const,
                image,
                mediaType: "image/jpeg",
              })),
            ],
          },
        ],
      });
      return { fixtureId: fixture.id, model: modelId, ok: true, response: object };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Rate-limit errors need the full per-minute window, not the normal gap.
      await delay(/quota|rate.?limit|429/i.test(lastError) ? 35_000 : CALL_GAP_MS);
    }
  }
  return { fixtureId: fixture.id, model: modelId, ok: false, error: lastError };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const modelId = resolveModelId("vision", {
    provider: "google",
    modelId: flag("model"),
  });

  let gold = goldFixturesSchema.parse(JSON.parse(readFileSync(FIXTURES, "utf8")));
  const only = flag("only");
  if (only) gold = gold.filter((f) => f.id === only);
  const limit = flag("limit");
  if (limit) gold = gold.slice(0, Number(limit));
  if (gold.length === 0) throw new Error("No fixtures selected.");

  console.log(`Measuring ${gold.length} fixture(s) with ${modelId} (google)…`);
  const fresh: PredictionRecord[] = [];
  for (const [i, fixture] of gold.entries()) {
    const p = await measureOne(fixture, modelId);
    fresh.push(p);
    const got = p.ok ? `${p.response?.measurements?.length ?? 0} measurements` : `FAILED: ${p.error}`;
    console.log(`  [${i + 1}/${gold.length}] ${fixture.id}: ${got}`);
    if (i < gold.length - 1) await delay(CALL_GAP_MS);
  }

  // Merge with any prior run so --only/--limit reruns update records in place
  // instead of discarding the rest of the (paid-for) predictions.
  const prior: PredictionRecord[] = existsSync(PREDICTIONS)
    ? (JSON.parse(readFileSync(PREDICTIONS, "utf8")) as PredictionRecord[])
    : [];
  const freshIds = new Set(fresh.map((p) => p.fixtureId));
  const predictions = [...prior.filter((p) => !freshIds.has(p.fixtureId)), ...fresh];

  writeFileSync(PREDICTIONS, `${JSON.stringify(predictions, null, 2)}\n`);
  const failed = predictions.filter((p) => !p.ok).length;
  console.log(`\nWrote ${PREDICTIONS} (${predictions.length} records, ${failed} failed).`);
  if (failed > 0) process.exitCode = 1;
}

main();

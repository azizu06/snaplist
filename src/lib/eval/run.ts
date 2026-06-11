import { readFile } from "node:fs/promises";
import {
  GOLD_SET,
  JUDGE_HUMAN_LABELS,
  SAMPLE_PREDICTIONS,
  parsePredictions,
} from "./fixtures";
import { createHeuristicJudge, createOpenAIJudge, DEFAULT_JUDGE_MODEL } from "./judge";
import { formatReport, runEval } from "./report";
import {
  judgedListingSchema,
  predictionFromLogRow,
  type EvalPrediction,
  type JudgedListing,
} from "./types";

/**
 * `pnpm eval` — the eval-harness entrypoint (issue #16).
 *
 * OFFLINE BY DEFAULT: with no flags it scores the checked-in sample predictions
 * fixture against the gold set using the deterministic heuristic judge — no
 * network, no keys, no database. Flags opt into the real world:
 *
 *   --predictions <path>  score a predictions JSON file (EvalPrediction[])
 *   --db                  read logged predictions from `prediction_logs` via the
 *                         local/linked Supabase (SUPABASE_URL + a key in env);
 *                         rows are matched to gold items by `GoldItem.itemId`
 *                         and listing copy is joined from `listings`
 *   --real-judge          use the LLM judge (OPENAI_API_KEY; model via
 *                         EVAL_JUDGE_MODEL, default gpt-5.5) instead of the
 *                         offline heuristic
 *   --json                emit the raw report JSON instead of the text table
 *
 * Every run validates the active judge against the human-labeled fixture and
 * reports the agreement metric alongside the listing scores. CI wiring is
 * deliberately out of scope here (issue #18).
 */

interface CliArgs {
  predictionsPath?: string;
  db: boolean;
  realJudge: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { db: false, realJudge: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--predictions": {
        const path = argv[i + 1];
        if (path === undefined || path.startsWith("--")) {
          throw new Error("--predictions requires a file path");
        }
        args.predictionsPath = path;
        i += 1;
        break;
      }
      case "--db":
        args.db = true;
        break;
      case "--real-judge":
        args.realJudge = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.predictionsPath !== undefined && args.db) {
    throw new Error("--predictions and --db are mutually exclusive");
  }
  return args;
}

/** Load predictions from a JSON file (the offline/demo seam). */
async function loadPredictionsFile(path: string): Promise<EvalPrediction[]> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return parsePredictions(raw);
}

/**
 * Read logged predictions from the real database. Lazy-imports the Supabase
 * client (mirroring `listing/generate.ts`) so the offline default path never
 * loads it. Matches rows to gold items via `GoldItem.itemId` and joins listing
 * copy from `listings` so the judge has something to score.
 *
 * DEDUP GUARANTEE: `readPredictionLogs` returns rows ordered by `created_at`
 * ascending, and `matchPredictions` keeps the LAST prediction per gold item —
 * so when an item has been run multiple times, the eval deterministically
 * scores the NEWEST run, never an arbitrary historical one.
 */
/**
 * Resolve the credentials the `--db` path is allowed to use. SERVICE ROLE
 * ONLY: prediction_logs/listings RLS requires the `authenticated` role with
 * auth.uid() = user_id, so an anon-key client would not error — it would
 * return EMPTY arrays and produce a normal-looking report scored over
 * nothing. The eval script is a server-side cross-tenant read; the service
 * role is the honest credential for it. Exported for tests.
 */
export function requireDbCredentials(
  env: Record<string, string | undefined> = process.env,
): { url: string; key: string } {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "--db requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. An anon key " +
        "is NOT accepted: RLS would silently return zero rows.",
    );
  }
  return { url, key };
}

/**
 * Fold chronologically-ascending eBay listing rows into a newest-listing-per-
 * item map (later rows overwrite earlier ones). The caller's query supplies
 * the ordering + platform='ebay' filter; this keeps the LAST valid row, so
 * the judged surface is always the newest eBay listing — never a stale rerun
 * or an export-pack row. Exported for tests.
 */
export function collectJudgedListings(
  rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, JudgedListing> {
  const byItem = new Map<string, JudgedListing>();
  for (const row of rows) {
    const copy = (row.copy ?? {}) as Record<string, unknown>;
    const candidate = judgedListingSchema.safeParse({
      title: row.title ?? "",
      description: row.description ?? "",
      itemSpecifics: copy["itemSpecifics"],
      tags: copy["tags"],
    });
    if (candidate.success && candidate.data.title !== "") {
      byItem.set(row.item_id as string, candidate.data);
    }
  }
  return byItem;
}

/**
 * The fail-fast guard for the `--db` path: zero gold-matched prediction rows
 * means stale/mistyped GoldItem.itemId mappings, missing runs, or a
 * credentials/RLS problem — never print a normal-looking report scored over
 * nothing. Exported for tests.
 */
export function ensureGoldMatchedRows(count: number): void {
  if (count === 0) {
    throw new Error(
      "--db: 0 prediction logs matched the gold set's itemIds — check " +
        "GoldItem.itemId mappings, credentials/RLS, and that pipeline runs " +
        "exist for the gold items.",
    );
  }
}

async function loadPredictionsFromDb(): Promise<EvalPrediction[]> {
  const { url, key } = requireDbCredentials();
  const [{ createClient }, { readPredictionLogs }] = await Promise.all([
    import("@supabase/supabase-js"),
    import("../pipeline/prediction-log"),
  ]);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const goldIdByItemId = new Map<string, string>();
  for (const g of GOLD_SET) {
    if (g.itemId !== undefined) goldIdByItemId.set(g.itemId, g.id);
  }
  if (goldIdByItemId.size === 0) {
    throw new Error(
      "--db: no gold items carry an `itemId` mapping. Fill in GoldItem.itemId " +
        "(fixtures/gold-set.json) with the `items.id` uuids of the gold runs.",
    );
  }

  // ONE newest-first, limit-1 query per gold item: this is what makes the
  // selection immune to PostgREST's `api.max_rows` cap (1000 locally) — an
  // unbounded ascending read of a large table silently returns only the
  // OLDEST page, so "keep last" would score stale runs while claiming the
  // newest. Per-item limit-1 reads cannot be clipped.
  const rows = (
    await Promise.all(
      [...goldIdByItemId.keys()].map((itemId) =>
        readPredictionLogs(client, { itemId, ascending: false, limit: 1 }),
      ),
    )
  ).flat();
  // Never score a normal-looking report over nothing: the credentials may be
  // fine while every configured GoldItem.itemId is stale/mistyped — that must
  // be an error, not a report with evaluated: 0.
  ensureGoldMatchedRows(rows.length);
  const itemIds = rows.map((r) => r.item_id);

  // Join listing copy for the judged surface (prediction_logs carries no copy).
  // DETERMINISTIC ASSOCIATION: items accrue many listings rows (reruns insert
  // a new one each time; #15 persists facebook/mercari export packs in the
  // same table), so the judged surface is pinned to the NEWEST EBAY listing
  // per item — consistent with the newest-prediction dedup above. The query
  // orders ascending and the map keeps the last row per item.
  // Same per-item newest-first pattern for the judged listing: a single
  // capped bulk read could clip the newest rows once enough reruns accrue.
  let listingByItemId = new Map<string, JudgedListing>();
  if (itemIds.length > 0) {
    const perItem = await Promise.all(
      itemIds.map(async (itemId) => {
        const { data, error } = await client
          .from("listings")
          .select("item_id, title, description, copy, created_at")
          .eq("item_id", itemId)
          .eq("platform", "ebay")
          .order("created_at", { ascending: false })
          .limit(1);
        if (error) {
          throw new Error(`Failed to read listings for eval: ${error.message}`);
        }
        return data ?? [];
      }),
    );
    listingByItemId = collectJudgedListings(perItem.flat());
  }

  const predictions: EvalPrediction[] = [];
  for (const row of rows) {
    const prediction = predictionFromLogRow(
      row,
      goldIdByItemId,
      listingByItemId.get(row.item_id),
    );
    if (prediction !== null) predictions.push(prediction);
  }
  return predictions;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);

  const predictions = args.db
    ? await loadPredictionsFromDb()
    : args.predictionsPath !== undefined
      ? await loadPredictionsFile(args.predictionsPath)
      : SAMPLE_PREDICTIONS;

  const judge = args.realJudge ? createOpenAIJudge() : createHeuristicJudge();
  const judgeName = args.realJudge
    ? `llm:${process.env.EVAL_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL}`
    : "heuristic-offline";

  const report = await runEval({
    gold: GOLD_SET,
    predictions,
    judge,
    judgeName,
    humanLabels: JUDGE_HUMAN_LABELS,
  });

  // CLI output is the product here.
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

// Entry point when invoked as a script (`pnpm eval`); never auto-runs on import
// from tests because the test runner imports modules, not argv-bearing scripts.
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(
    process.argv[1].split("/").pop() ?? "<never-matches>",
  );

if (isDirectRun) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

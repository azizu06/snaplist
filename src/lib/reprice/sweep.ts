import type { SupabaseClient } from "@supabase/supabase-js";
import { extractedAttributesSchema, type PipelineResult } from "../pipeline/types";
import { attributesToSignal } from "../pipeline/stub";
import { logPrediction } from "../pipeline/prediction-log";
import { priceToConfidence } from "../confidence/from-price";
import { createDefaultPricer } from "../pricing/default-pricer";
import type { ItemSignal, PriceResult } from "../pricing";
import { createEbayAdapter, type EbayAdapter } from "../marketplace/ebay";
import { marketplaceCurrency } from "../marketplace/ebay/map";
import { createNotification } from "../notifications";
import { reportServerError } from "../sentry";
import { logEvent } from "../observability";
import {
  decideReprice,
  resolveRepriceConfig,
  type RepriceConfig,
  type RepriceDecision,
} from "./policy";

/**
 * The stale-inventory repricing sweep (issue #102) — what the cron route runs.
 *
 * One run:
 *   1. selects up to `batchSize` LIVE eBay listings whose last price event is
 *      older than `staleDays` (the batch cap is the scraper rate-limit / spend
 *      guardrail — sold comps are live-fetched through the normal pricing
 *      path, TTL cache-on-miss and all),
 *   2. re-prices each through the SAME router + calibrated confidence bridge
 *      the upload pipeline uses, and logs the run to `prediction_logs`
 *      (PRD non-negotiable — this feeds the eval harness),
 *   3. on material drift persists a `reprice_suggestions` row + a bell
 *      notification with the evidence (fresh comps, drift %, confidence),
 *   4. AUTO-APPLIES only when the run is autopilot-eligible per the composite
 *      confidence gate AND the seller's auto-reprice toggle (default OFF) is
 *      on — revising the live listing through the eBay adapter (mockable) and
 *      recording the change; never below the seller's price floor.
 *
 * TENANCY: the cron has no user session, so the sweep runs on the SERVICE-ROLE
 * client (src/lib/supabase/admin.ts documents cron as a trusted path). Every
 * row it touches is loaded WITH its user_id and every write filters on BOTH
 * the row id AND that user_id — belt-and-braces so a bug can never write
 * across tenants even though the service role could.
 *
 * The pure decisions (stale? drifted? eligible? floor?) live in policy.ts;
 * this module is the I/O choreography around them, with every external
 * dependency injectable so the whole sweep is testable offline.
 */

/** The listing columns the sweep scans (see `candidate` query below). */
interface CandidateListing {
  id: string;
  user_id: string;
  item_id: string;
  title: string | null;
  ebay_offer_id: string | null;
  listed_price: number | string | null;
  last_priced_at: string | null;
}

interface CandidateItem {
  id: string;
  user_id: string;
  attributes: unknown;
  price_override: number | string | null;
  price_floor: number | string | null;
}

interface UserSettingsRow {
  user_id: string;
  autopilot_enabled: boolean | null;
  auto_reprice_enabled: boolean | null;
}

export interface RepriceSweepDeps {
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => Date;
  /** Price an item signal. Defaults to the REAL PriceRouter over all PRD tiers. */
  priceItem?: (signal: ItemSignal) => Promise<PriceResult>;
  /**
   * eBay adapter used for auto-apply revisions. Defaults to the app-level env
   * adapter (the sandbox loop): per-user OAuth token providers need the
   * seller's RLS-scoped session client, which a cron doesn't have — routing
   * per-user connections through the sweep is the #17-production follow-up.
   */
  adapter?: EbayAdapter;
  /** Injectable env reader (currency guard); defaults to process.env. */
  env?: () => Record<string, string | undefined>;
  /** Config overrides; defaults to `resolveRepriceConfig(env)`. */
  config?: Partial<RepriceConfig>;
}

export interface RepriceSweepOutcome {
  itemId: string;
  listingId: string;
  action: RepriceDecision["action"] | "error";
  detail?: string;
}

export interface RepriceSweepSummary {
  scanned: number;
  suggested: number;
  autoApplied: number;
  unchanged: number;
  failed: number;
  outcomes: RepriceSweepOutcome[];
}

/** `model` stamped on sweep prediction logs — no vision call runs in a reprice. */
export const REPRICE_SWEEP_MODEL = "reprice-sweep";

/** The currency every persisted price is denominated in (mirrors publish.ts). */
const PRICING_CURRENCY = "USD";

const toNumber = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

export async function runRepriceSweep(
  supabase: SupabaseClient,
  deps: RepriceSweepDeps = {},
): Promise<RepriceSweepSummary> {
  const readEnv = deps.env ?? (() => process.env);
  const config: RepriceConfig = {
    ...resolveRepriceConfig(readEnv()),
    ...deps.config,
  };
  const now = deps.now ?? (() => new Date());
  const priceItem = deps.priceItem ?? createDefaultPricer();

  const summary: RepriceSweepSummary = {
    scanned: 0,
    suggested: 0,
    autoApplied: 0,
    unchanged: 0,
    failed: 0,
    outcomes: [],
  };

  // --- 1. Candidate scan: live eBay listings past the staleness window. -----
  const cutoffIso = new Date(
    now().getTime() - config.staleDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: candidates, error: scanError } = await supabase
    .from("listings")
    .select(
      "id, user_id, item_id, title, ebay_offer_id, listed_price, last_priced_at",
    )
    .eq("platform", "ebay")
    .eq("ebay_status", "published")
    .or(`last_priced_at.is.null,last_priced_at.lt.${cutoffIso}`)
    .order("last_priced_at", { ascending: true, nullsFirst: true })
    .limit(config.batchSize);
  if (scanError) {
    throw new Error(`Reprice sweep candidate scan failed: ${scanError.message}`);
  }
  const listings = (candidates ?? []) as unknown as CandidateListing[];
  if (listings.length === 0) return summary;

  // --- 2. Batch-load the items and each owner's switches. -------------------
  const itemIds = [...new Set(listings.map((l) => l.item_id))];
  const userIds = [...new Set(listings.map((l) => l.user_id))];
  const [{ data: itemRows, error: itemsError }, { data: settingsRows, error: settingsError }] =
    await Promise.all([
      supabase
        .from("items")
        .select("id, user_id, attributes, price_override, price_floor")
        .in("id", itemIds),
      supabase
        .from("user_settings")
        .select("user_id, autopilot_enabled, auto_reprice_enabled")
        .in("user_id", userIds),
    ]);
  if (itemsError) {
    throw new Error(`Reprice sweep items load failed: ${itemsError.message}`);
  }
  if (settingsError) {
    throw new Error(`Reprice sweep settings load failed: ${settingsError.message}`);
  }
  const itemsById = new Map(
    ((itemRows ?? []) as unknown as CandidateItem[]).map((i) => [i.id, i]),
  );
  const settingsByUser = new Map(
    ((settingsRows ?? []) as unknown as UserSettingsRow[]).map((s) => [s.user_id, s]),
  );

  for (const listing of listings) {
    summary.scanned += 1;
    try {
      const outcome = await repriceOne(supabase, listing, {
        item: itemsById.get(listing.item_id),
        settings: settingsByUser.get(listing.user_id),
        priceItem,
        adapter: deps.adapter,
        readEnv,
        config,
        now,
      });
      summary.outcomes.push(outcome);
      if (outcome.action === "suggest") summary.suggested += 1;
      else if (outcome.action === "auto_apply") summary.autoApplied += 1;
      else if (outcome.action === "error") summary.failed += 1;
      else summary.unchanged += 1;
    } catch (err) {
      // Batch resilience: one poisoned item must not sink the sweep. The
      // cursor is still advanced (below) so a persistently failing listing
      // can't wedge the head of every future batch; it retries next window.
      summary.failed += 1;
      summary.outcomes.push({
        itemId: listing.item_id,
        listingId: listing.id,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
      reportServerError("reprice.sweep.item", err, { listingId: listing.id });
    }
    await touchPriceCursor(supabase, listing, now().toISOString());
  }

  logEvent("reprice.sweep", {
    scanned: summary.scanned,
    suggested: summary.suggested,
    autoApplied: summary.autoApplied,
    unchanged: summary.unchanged,
    failed: summary.failed,
  });
  return summary;
}

interface RepriceOneContext {
  item: CandidateItem | undefined;
  settings: UserSettingsRow | undefined;
  priceItem: (signal: ItemSignal) => Promise<PriceResult>;
  adapter: EbayAdapter | undefined;
  readEnv: () => Record<string, string | undefined>;
  config: RepriceConfig;
  now: () => Date;
}

async function repriceOne(
  supabase: SupabaseClient,
  listing: CandidateListing,
  ctx: RepriceOneContext,
): Promise<RepriceSweepOutcome> {
  const { item, settings, config } = ctx;
  const base: Omit<RepriceSweepOutcome, "action"> = {
    itemId: listing.item_id,
    listingId: listing.id,
  };
  if (!item || item.user_id !== listing.user_id) {
    // A missing/mismatched item is an anomaly — skip, never guess a tenant.
    return { ...base, action: "error", detail: "item missing or tenant mismatch" };
  }

  const parsed = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const attributes = parsed.success ? parsed.data : {};
  const autopilotEnabled = settings?.autopilot_enabled ?? true;
  const autoRepriceEnabled = settings?.auto_reprice_enabled ?? false;

  // --- Fresh research through the normal pricing path (live-fetched sold
  // comps with the TTL cache-on-miss + age-decay layer, #59). ----------------
  const price = await ctx.priceItem(attributesToSignal(attributes));
  const confidence = priceToConfidence(attributes, price, { autopilotEnabled });

  // --- Log the run (PRD: every run's predictions, from day one). ------------
  // `buildPredictionLogRow` never reads `listing`, so a minimal placeholder
  // keeps the PipelineResult type honest (the review sharpen action's pattern).
  const runId = crypto.randomUUID();
  const result: PipelineResult = {
    attributes,
    price,
    confidence,
    listing: { platform: "ebay", title: "", description: "", fields: {} },
    model: REPRICE_SWEEP_MODEL,
    pricingModel: price.model,
  };
  await logPrediction(supabase, listing.user_id, listing.item_id, result, {
    autopilotEnabled,
    runId,
  });

  // --- Decide: none / suggest / auto-apply (pure, policy.ts). ---------------
  // Current price precedence mirrors `effectivePrice`: the seller's override
  // is what every consumer uses when set; else the price the listing actually
  // published at.
  const currentPrice =
    toNumber(item.price_override) ?? toNumber(listing.listed_price);
  const decision = decideReprice({
    currentPrice,
    suggestedPrice: price.suggested,
    priceFloor: toNumber(item.price_floor),
    autopilotEligible: confidence.autopilotEligible,
    autoRepriceEnabled,
    driftThresholdPct: config.driftThresholdPct,
  });

  if (decision.action === "none") {
    return { ...base, action: "none", detail: decision.reason };
  }

  if (decision.action === "auto_apply") {
    const applied = await tryAutoApply(supabase, listing, {
      ctx,
      currentPrice: currentPrice as number,
      decision,
      price,
      confidence,
      runId,
    });
    if (applied) return { ...base, action: "auto_apply" };
    // Fall through: an auto-apply that couldn't revise the live listing
    // degrades to a suggestion so the seller can still act on the evidence.
  }

  await persistSuggestion(supabase, listing, {
    currentPrice: currentPrice as number,
    decision,
    price,
    confidence,
    runId,
    status: "pending",
    appliedPrice: null,
    now: ctx.now,
  });
  await createNotification(supabase, {
    userId: listing.user_id,
    kind: "system",
    title: `Price check: consider ${formatUsd(decision.targetPrice)} for “${listingTitle(listing)}”`,
    body:
      `Fresh comps put it around ${formatUsd(price.suggested)} ` +
      `(${formatDrift(decision.driftPct)} vs your ${formatUsd(currentPrice as number)}). ` +
      "Review the suggestion on your dashboard.",
    href: "/dashboard",
    itemId: listing.item_id,
    listingId: listing.id,
  });
  return { ...base, action: "suggest" };
}

interface ApplyContext {
  ctx: RepriceOneContext;
  currentPrice: number;
  decision: Extract<RepriceDecision, { action: "suggest" | "auto_apply" }>;
  price: PriceResult;
  confidence: { score: number; autopilotEligible: boolean };
  runId: string;
}

/**
 * Revise the live listing through the adapter and record the change.
 * Returns false (degrade to suggest-only) when the listing can't be revised —
 * no offer id, non-USD marketplace without an explicit EBAY_CURRENCY (mirrors
 * the publish guard: relabeling an amount misprices the listing), or an
 * adapter failure.
 */
async function tryAutoApply(
  supabase: SupabaseClient,
  listing: CandidateListing,
  apply: ApplyContext,
): Promise<boolean> {
  const { ctx, decision } = apply;
  if (!listing.ebay_offer_id) {
    reportServerError(
      "reprice.autoApply.noOffer",
      new Error(`listing ${listing.id} has no ebay_offer_id`),
    );
    return false;
  }
  const env = ctx.readEnv();
  const currency = marketplaceCurrency(env.EBAY_MARKETPLACE_ID, env.EBAY_CURRENCY);
  if (!env.EBAY_CURRENCY && currency !== PRICING_CURRENCY) {
    reportServerError(
      "reprice.autoApply.currency",
      new Error(`refusing to relabel ${PRICING_CURRENCY} price as ${currency}`),
      { listingId: listing.id },
    );
    return false;
  }

  const adapter = ctx.adapter ?? createEbayAdapter();
  try {
    await adapter.revisePrice({
      sku: listing.id,
      offerId: listing.ebay_offer_id,
      price: { value: apply.decision.targetPrice.toFixed(2), currency },
    });
  } catch (err) {
    reportServerError("reprice.autoApply.revise", err, { listingId: listing.id });
    return false;
  }

  // The revision is LIVE — record it everywhere downstream consumers read:
  // the audit row, the seller's effective price, and the listing's live price.
  // Every write here is best-effort so an irreversible eBay change is never
  // stranded by a failing bookkeeping step.
  const nowIso = ctx.now().toISOString();
  try {
    await persistSuggestion(supabase, listing, {
      currentPrice: apply.currentPrice,
      decision,
      price: apply.price,
      confidence: apply.confidence,
      runId: apply.runId,
      status: "auto_applied",
      appliedPrice: decision.targetPrice,
      now: ctx.now,
    });
  } catch (err) {
    reportServerError("reprice.autoApply.audit", err, { listingId: listing.id });
  }
  const [{ error: itemError }, { error: listingError }] = await Promise.all([
    supabase
      .from("items")
      .update({ price_override: decision.targetPrice })
      .eq("id", listing.item_id)
      .eq("user_id", listing.user_id),
    supabase
      .from("listings")
      .update({ listed_price: decision.targetPrice, last_priced_at: nowIso })
      .eq("id", listing.id)
      .eq("user_id", listing.user_id),
  ]);
  if (itemError || listingError) {
    // The eBay revision is live; surface loudly so the operator reconciles.
    reportServerError(
      "reprice.autoApply.persist",
      new Error((itemError ?? listingError)!.message),
      { listingId: listing.id },
    );
  }
  await createNotification(supabase, {
    userId: listing.user_id,
    kind: "system",
    title: `Autopilot repriced “${listingTitle(listing)}” to ${formatUsd(decision.targetPrice)}`,
    body:
      `Was ${formatUsd(apply.currentPrice)} — fresh sold comps moved ` +
      `${formatDrift(decision.driftPct)} (confidence ${Math.round(apply.confidence.score * 100)}%).` +
      (decision.flooredToMinimum ? " Held at your price floor." : ""),
    href: `/listings/${listing.id}`,
    itemId: listing.item_id,
    listingId: listing.id,
  });
  return true;
}

interface SuggestionWrite {
  currentPrice: number;
  decision: Extract<RepriceDecision, { action: "suggest" | "auto_apply" }>;
  price: PriceResult;
  confidence: { score: number; autopilotEligible: boolean };
  runId: string;
  status: "pending" | "auto_applied";
  appliedPrice: number | null;
  now: () => Date;
}

/**
 * Persist one suggestion row, superseding any still-pending suggestion for the
 * listing first (the partial unique index allows one pending per listing —
 * a fresh sweep's evidence replaces stale evidence instead of piling up).
 */
async function persistSuggestion(
  supabase: SupabaseClient,
  listing: CandidateListing,
  write: SuggestionWrite,
): Promise<void> {
  const nowIso = write.now().toISOString();
  const { error: supersedeError } = await supabase
    .from("reprice_suggestions")
    .update({ status: "superseded", resolved_at: nowIso })
    .eq("listing_id", listing.id)
    .eq("user_id", listing.user_id)
    .eq("status", "pending");
  if (supersedeError) {
    throw new Error(`Failed to supersede old suggestion: ${supersedeError.message}`);
  }
  const { error } = await supabase.from("reprice_suggestions").insert({
    user_id: listing.user_id,
    item_id: listing.item_id,
    listing_id: listing.id,
    current_price: write.currentPrice,
    suggested_price: write.price.suggested,
    target_price: write.decision.targetPrice,
    price_range: { low: write.price.range.min, high: write.price.range.max },
    drift_pct: write.decision.driftPct,
    confidence: write.confidence.score,
    autopilot_eligible: write.confidence.autopilotEligible,
    tier_fired: write.price.tier,
    sources: write.price.sources,
    floored_to_minimum: write.decision.flooredToMinimum,
    status: write.status,
    applied_price: write.appliedPrice,
    run_id: write.runId,
    resolved_at: write.status === "auto_applied" ? nowIso : null,
  });
  if (error) {
    throw new Error(`Failed to persist reprice suggestion: ${error.message}`);
  }
}

/**
 * Advance the staleness cursor for a swept listing — even on error or
 * "unchanged", so the batch walks the whole live inventory instead of
 * re-scanning the same head every run. Best-effort: a failed stamp only means
 * the listing is looked at again next run.
 */
async function touchPriceCursor(
  supabase: SupabaseClient,
  listing: CandidateListing,
  nowIso: string,
): Promise<void> {
  const { error } = await supabase
    .from("listings")
    .update({ last_priced_at: nowIso })
    .eq("id", listing.id)
    .eq("user_id", listing.user_id);
  if (error) {
    reportServerError("reprice.sweep.cursor", new Error(error.message), {
      listingId: listing.id,
    });
  }
}

function listingTitle(listing: CandidateListing): string {
  const t = listing.title?.trim();
  return t && t.length > 0 ? t : "your listing";
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDrift(pct: number): string {
  const rounded = Math.round(Math.abs(pct));
  return `${pct < 0 ? "down" : "up"} ${rounded}%`;
}

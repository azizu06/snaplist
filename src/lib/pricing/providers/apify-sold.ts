import { ApifyClient } from "apify-client";
import type { TtlCache } from "../comp-cache";
import {
  SOLD_HALFLIFE_DAYS_DEFAULT,
  SOLD_STALE_DAYS_DEFAULT,
} from "../freshness";
import { selectSoldCompEvidence } from "../sold-comp-matcher";
import {
  pricingEvidenceShippingSchema,
  type ItemSignal,
  type PriceResult,
  type PricingEvidenceFormat,
  type PricingEvidenceShipping,
  type PricingProvider,
} from "../types";
import { logEvent, type LogFields } from "../../observability";
import {
  buildSoldSearchQuery,
  canonicalEbayItemUrl,
  finalizeVerifiedSoldResult,
  normalizeEbaySoldCompUrls,
  type EbaySoldComp,
} from "./ebay-sold";

/** The exact Caffein Dev Actor and build evaluated by issues #188/#198. */
export const APIFY_SOLD_ACTOR_ID = "oTtB3VgfuE9GtxQt2";
export const APIFY_SOLD_ACTOR_BUILD_DEFAULT = "1.18.3";
export const APIFY_SOLD_INITIAL_RESULTS = 10;
export const APIFY_SOLD_MAX_RESULTS_DEFAULT = 20;
export const APIFY_SOLD_EXPANSION_THRESHOLD = 3;
export const APIFY_SOLD_DAYS_TO_SCRAPE_DEFAULT = 90;
export const APIFY_SOLD_REQUEST_RETRIES_DEFAULT = 2;
export const APIFY_SOLD_ACTOR_TIMEOUT_SECS_DEFAULT = 55;
export const APIFY_SOLD_WAIT_SECS_DEFAULT = 60;
/**
 * Fail closed if the tested per-result economics drift above the #188 envelope.
 * This is a per-run platform ceiling, not an authorization to activate or spend.
 */
export const APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT = 0.11;
export const APIFY_SOLD_CIRCUIT_FAILURE_THRESHOLD_DEFAULT = 3;
export const APIFY_SOLD_CIRCUIT_COOLDOWN_MS_DEFAULT = 60_000;
const APIFY_SOLD_COORDINATION_ALLOWANCE_MS = 500;
const APIFY_SOLD_WINNER_OBSERVATION_POLL_MS_MAX = 5_000;
const APIFY_SOLD_WINNER_STORE_POLL_MS = 25;
const APIFY_SOLD_WINNER_CACHE_READ_BUDGET_MS = 10;
const APIFY_SOLD_DEADLINE_MARGIN_MS = 1;
const APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS_DEFAULT = 15_000;
const APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS_MIN = 3_000;
const APIFY_SOLD_CLAIM_AUTHORITY_CLOCK_SKEW_MS = 1_000;
const APIFY_SOLD_PRICING_DEADLINE_EXCEEDED = Symbol(
  "apify-sold-pricing-deadline-exceeded",
);
const APIFY_SOLD_CLAIM_RESPONSE_REJECTED = Symbol(
  "apify-sold-claim-response-rejected",
);

async function settleBeforeApifyPricingDeadline<T>(
  startOperation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  cancellationSignal?: AbortSignal,
): Promise<T | typeof APIFY_SOLD_PRICING_DEADLINE_EXCEEDED> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return APIFY_SOLD_PRICING_DEADLINE_EXCEEDED;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      startOperation(controller.signal),
      new Promise<typeof APIFY_SOLD_PRICING_DEADLINE_EXCEEDED>((resolve) => {
        timer = setTimeout(() => {
          resolve(APIFY_SOLD_PRICING_DEADLINE_EXCEEDED);
          controller.abort();
        }, remainingMs);
      }),
      new Promise<typeof APIFY_SOLD_PRICING_DEADLINE_EXCEEDED>((resolve) => {
        cancel = () => {
          resolve(APIFY_SOLD_PRICING_DEADLINE_EXCEEDED);
          controller.abort();
        };
        if (cancellationSignal?.aborted) cancel();
        else cancellationSignal?.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) cancellationSignal?.removeEventListener("abort", cancel);
  }
}

async function delayBeforeApifyPricingDeadline(
  delayMs: number,
  deadline: number,
  cancellationSignal: AbortSignal,
): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0 || cancellationSignal.aborted) return false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.min(delayMs, remainingMs));
      cancel = () => resolve(false);
      cancellationSignal.addEventListener("abort", cancel, { once: true });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) cancellationSignal.removeEventListener("abort", cancel);
  }
}

export interface ApifySoldComp extends EbaySoldComp {
  isBestOfferAccepted?: boolean;
  priceDisclosure?: "displayed-sold-price" | "asking-price-not-accepted-amount";
}

function sameShipping(
  observed: PricingEvidenceShipping | undefined,
  expected: PricingEvidenceShipping | undefined,
): boolean {
  if (observed == null || expected == null) return observed === expected;
  if (observed.type !== expected.type) return false;
  return observed.type !== "paid" || expected.type !== "paid"
    ? true
    : observed.price === expected.price
      && observed.currency === expected.currency;
}

function sameApifySoldComps(
  observed: readonly ApifySoldComp[],
  expected: readonly ApifySoldComp[],
): boolean {
  return (
    observed.length === expected.length &&
    observed.every((comp, index) => {
      const expectedComp = expected[index];
      return (
        expectedComp != null &&
        comp.url === expectedComp.url &&
        comp.title === expectedComp.title &&
        comp.price === expectedComp.price &&
        comp.condition === expectedComp.condition &&
        comp.soldAt === expectedComp.soldAt &&
        comp.photoUrl === expectedComp.photoUrl &&
        comp.size === expectedComp.size &&
        comp.format === expectedComp.format &&
        sameShipping(comp.shipping, expectedComp.shipping) &&
        comp.isBestOfferAccepted === expectedComp.isBestOfferAccepted &&
        comp.priceDisclosure === expectedComp.priceDisclosure
      );
    })
  );
}

interface ApifyCircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

interface ApifyRuntimeState {
  inFlight: Map<string, Promise<ApifySoldComp[] | null>>;
  circuits: Map<string, ApifyCircuitState>;
}

/**
 * `createDefaultPricer` is request-scoped, but its cache object is shared by the
 * composition root. Key single-flight work by that cache identity so concurrent
 * request-scoped providers in one runtime cannot duplicate a paid Actor start or
 * reset the failure breaker. Flight entries remove themselves on settlement;
 * the weak key does not retain caches.
 */
const APIFY_RUNTIME_STATE_BY_CACHE = new WeakMap<
  TtlCache<ApifySoldComp[]>,
  ApifyRuntimeState
>();

function runtimeStateFor(
  cache: TtlCache<ApifySoldComp[]> | undefined,
): ApifyRuntimeState {
  if (!cache) return { inFlight: new Map(), circuits: new Map() };
  let state = APIFY_RUNTIME_STATE_BY_CACHE.get(cache);
  if (!state) {
    state = { inFlight: new Map(), circuits: new Map() };
    APIFY_RUNTIME_STATE_BY_CACHE.set(cache, state);
  }
  return state;
}

function circuitStateFor(state: ApifyRuntimeState, key: string): ApifyCircuitState {
  let circuit = state.circuits.get(key);
  if (!circuit) {
    circuit = { consecutiveFailures: 0, openUntil: 0 };
    state.circuits.set(key, circuit);
  }
  return circuit;
}

export interface ApifySoldActorInput {
  keywords: string[];
  count: number;
  daysToScrape: number;
  ebaySite: "ebay.com";
  sortOrder: "endedRecently";
  itemLocation: "default";
  itemCondition: "any";
  includeCompletedListings: true;
}

export interface ApifySoldRunRequest {
  actorId: string;
  build: string;
  input: ApifySoldActorInput;
  maxItems: number;
  maxTotalChargeUsd: number;
  timeoutSecs: number;
  waitSecs: number;
  requestRetries: number;
  restartOnError: false;
}

export interface ApifySoldRunResult {
  status: string;
  items: readonly Record<string, unknown>[];
}

/** Injectable zero-network seam used by adapter/router tests. */
export type RunApifySoldActor = (
  request: ApifySoldRunRequest,
) => Promise<ApifySoldRunResult>;

export interface ApifySoldPricingProviderOptions {
  /** Explicit opt-in. Defaults to APIFY_SOLD_ENABLED, which is off by default. */
  enabled?: boolean;
  /** Server-side token. Never enters a URL, cache key, diagnostic, or result. */
  token?: string;
  runActor?: RunApifySoldActor;
  actorId?: string;
  actorBuild?: string;
  daysToScrape?: number;
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
  waitSecs?: number;
  requestRetries?: number;
  /** Exact-owner liveness window; env may tighten within the in-code safety bounds. */
  claimAuthorityWindowMs?: number;
  cache?: TtlCache<ApifySoldComp[]>;
  now?: () => number;
  staleDays?: number;
  halfLifeDays?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  emitDiagnostic?: (event: string, fields: LogFields) => void;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Default-off activation requires an explicit flag and a non-empty token. */
export function apifySoldConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const enabled = env.APIFY_SOLD_ENABLED?.trim().toLowerCase();
  return (
    (enabled === "true" || enabled === "1" || enabled === "on") &&
    Boolean(env.APIFY_TOKEN?.trim())
  );
}

/**
 * Whether ONE adapter instance is actually armed: the env activation gate (or an
 * explicit per-instance override) plus a usable token. `createApifySoldPricingProvider`
 * uses this to decide whether to run at all, and the composition root uses the SAME
 * function to name why the primary sold strategy was skipped — an unconfigured
 * primary must never be indistinguishable from one that ran and found nothing (#715).
 */
export function apifySoldActivated(
  options: ApifySoldPricingProviderOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const token = options.token?.trim() ?? env.APIFY_TOKEN?.trim() ?? "";
  const enabled = options.enabled ?? apifySoldConfigured(env);
  return enabled && token.length > 0;
}

function conditionFromId(value: unknown): string | undefined {
  const id = Number(value);
  if (!Number.isInteger(id)) return undefined;
  if (id === 1000) return "New";
  if (id === 1500) return "Open box";
  if (id === 1750) return "New with defects";
  if ([2000, 2010, 2020, 2030, 2500].includes(id)) return "Refurbished";
  if (id === 2750) return "Like new";
  if (id === 2990) return "Pre-owned - Excellent";
  if (id === 3000) return "Used";
  if (id === 3010) return "Pre-owned - Fair";
  if (id === 4000) return "Very good";
  if (id === 5000) return "Good";
  if (id === 6000) return "Acceptable";
  if (id === 7000) return "For parts or not working";
  return undefined;
}

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function soldTimestamp(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function suppliedHttpsPhotoUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && Boolean(url.host)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function suppliedBuyingFormat(value: unknown): PricingEvidenceFormat | undefined {
  switch (value) {
    case "auction":
      return "auction";
    case "buyItNow":
      return "buy-it-now";
    case "auctionWithBIN":
      return "auction-with-buy-it-now";
    default:
      return undefined;
  }
}

function suppliedSize(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sizes = Object.entries(value as Record<string, unknown>)
    .filter(([name]) => name.trim().toLowerCase() === "size")
    .map(([, rawSize]) => (typeof rawSize === "string" ? rawSize.trim() : ""))
    .filter((size) => size.length > 0 && size.length <= 120);
  return new Set(sizes).size === 1 ? sizes[0] : undefined;
}

function suppliedShipping(raw: Record<string, unknown>): PricingEvidenceShipping | undefined {
  const type =
    typeof raw.shippingType === "string"
      ? raw.shippingType.trim().toLowerCase()
      : "";
  if (type === "free") return { type: "free" };
  if (type === "pickup") return { type: "pickup" };
  if (type !== "paid") return undefined;

  const candidate = {
    type: "paid" as const,
    price: finitePositive(raw.shippingPrice),
    currency:
      typeof raw.shippingCurrency === "string"
        ? raw.shippingCurrency.trim().toUpperCase()
        : "",
  };
  const parsed = pricingEvidenceShippingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Normalize untrusted Actor rows into the provider-neutral sold-comp contract.
 * Seller identity, item IDs, unknown raw payload fields, and non-USD sold prices
 * never cross this boundary. Documented optional photo, item-specific size,
 * format, and shipping facts survive only when the Actor supplied schema-valid
 * values. Best Offer asking
 * prices remain labeled so the merged matcher can reject them rather than silently
 * treating them as accepted prices.
 */
export function normalizeApifySoldItems(
  rawItems: readonly unknown[],
  maxResults = APIFY_SOLD_MAX_RESULTS_DEFAULT,
): ApifySoldComp[] {
  const limit = Math.min(
    APIFY_SOLD_MAX_RESULTS_DEFAULT,
    positiveInteger(maxResults, APIFY_SOLD_MAX_RESULTS_DEFAULT),
  );
  const seen = new Set<string>();
  const normalized: ApifySoldComp[] = [];

  for (const value of rawItems) {
    if (normalized.length >= limit) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    const url = canonicalEbayItemUrl(raw.url);
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const price = finitePositive(raw.soldPrice);
    const currency =
      typeof raw.soldCurrency === "string" ? raw.soldCurrency.trim().toUpperCase() : "";
    if (!url || !title || price == null || currency !== "USD" || seen.has(url)) continue;

    const conditionText =
      typeof raw.condition === "string" && raw.condition.trim()
        ? raw.condition.trim()
        : conditionFromId(raw.conditionId);
    const listingType =
      typeof raw.listingType === "string"
        ? raw.listingType.trim().toLowerCase().replace(/[ -]+/g, "_")
        : "";
    const bestOffer =
      raw.isBestOfferAccepted === true ||
      listingType === "best_offer_accepted" ||
      raw.priceDisclosure === "asking-price-not-accepted-amount";
    const soldAt = soldTimestamp(raw.endedAt);
    const photoUrl = suppliedHttpsPhotoUrl(raw.thumbnailUrl);
    const size = suppliedSize(raw.itemSpecifics);
    const format = suppliedBuyingFormat(raw.buyingFormat);
    const shipping = suppliedShipping(raw);

    seen.add(url);
    normalized.push({
      url,
      title,
      price,
      ...(conditionText ? { condition: conditionText } : {}),
      ...(soldAt != null ? { soldAt } : {}),
      ...(photoUrl ? { photoUrl } : {}),
      ...(size ? { size } : {}),
      ...(format ? { format } : {}),
      ...(shipping ? { shipping } : {}),
      isBestOfferAccepted: bestOffer,
      priceDisclosure: bestOffer
        ? "asking-price-not-accepted-amount"
        : "displayed-sold-price",
    });
  }

  return normalized;
}

/** Official SDK runner. It is constructed inertly and performs no request until called. */
export function createDefaultApifySoldActorRunner(token: string): RunApifySoldActor {
  return async (request) => {
    // Never retry the paid Actor-start POST: an ambiguous transport failure must
    // fall through, not risk launching a duplicate paid run. The separate dataset
    // read is idempotent and may use the bounded request retry allowance.
    const runClient = new ApifyClient({
      token,
      maxRetries: 0,
      timeoutSecs: Math.min(request.timeoutSecs, 30),
      userAgentSuffix: "SnapList-pricing/1.0",
    });
    const run = await runClient.actor(request.actorId).call(request.input, {
      build: request.build,
      timeout: request.timeoutSecs,
      waitSecs: request.waitSecs,
      maxItems: request.maxItems,
      maxTotalChargeUsd: request.maxTotalChargeUsd,
      restartOnError: request.restartOnError,
      log: null,
    });
    if (run.status !== "SUCCEEDED" || !run.defaultDatasetId) {
      return { status: run.status, items: [] };
    }
    const readClient = new ApifyClient({
      token,
      maxRetries: request.requestRetries,
      timeoutSecs: Math.min(request.timeoutSecs, 30),
      userAgentSuffix: "SnapList-pricing/1.0",
    });
    const page = await readClient.dataset(run.defaultDatasetId).listItems({
      limit: request.maxItems,
    });
    const items = page.items.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
    return { status: run.status, items };
  };
}

function boundedStatus(status: string): string {
  return ["FAILED", "ABORTED", "TIMED-OUT", "READY", "RUNNING"].includes(status)
    ? status.toLowerCase()
    : "non-success";
}

/**
 * Caffein Apify adapter behind PricingProvider. Retrieval stays Actor-specific;
 * evidence decisions stay in the shared provider-neutral matcher.
 */
export function createApifySoldPricingProvider(
  options: ApifySoldPricingProviderOptions = {},
): PricingProvider {
  const token = options.token?.trim() ?? process.env.APIFY_TOKEN?.trim() ?? "";
  const active = apifySoldActivated(options);
  const actorId = options.actorId?.trim() || APIFY_SOLD_ACTOR_ID;
  const actorBuild =
    options.actorBuild?.trim() ||
    process.env.APIFY_SOLD_ACTOR_BUILD?.trim() ||
    APIFY_SOLD_ACTOR_BUILD_DEFAULT;
  const daysToScrape = Math.min(
    180,
    positiveInteger(
      options.daysToScrape ?? process.env.APIFY_SOLD_DAYS_TO_SCRAPE,
      APIFY_SOLD_DAYS_TO_SCRAPE_DEFAULT,
    ),
  );
  const timeoutSecs = Math.min(
    APIFY_SOLD_ACTOR_TIMEOUT_SECS_DEFAULT,
    positiveInteger(
      options.timeoutSecs ?? process.env.APIFY_SOLD_TIMEOUT_SECS,
      APIFY_SOLD_ACTOR_TIMEOUT_SECS_DEFAULT,
    ),
  );
  const waitSecs = Math.min(
    APIFY_SOLD_WAIT_SECS_DEFAULT,
    positiveInteger(
      options.waitSecs ?? process.env.APIFY_SOLD_WAIT_SECS,
      APIFY_SOLD_WAIT_SECS_DEFAULT,
    ),
  );
  const requestRetries = Math.min(
    APIFY_SOLD_REQUEST_RETRIES_DEFAULT,
    nonNegativeInteger(
      options.requestRetries ?? process.env.APIFY_SOLD_REQUEST_RETRIES,
      APIFY_SOLD_REQUEST_RETRIES_DEFAULT,
    ),
  );
  const maxTotalChargeUsd = Math.min(
    APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT,
    positiveNumber(
      options.maxTotalChargeUsd ?? process.env.APIFY_SOLD_MAX_TOTAL_CHARGE_USD,
      APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT,
    ),
  );
  const pricingWindowMs =
    Math.max(timeoutSecs, waitSecs) * 1_000 * 2 +
    APIFY_SOLD_COORDINATION_ALLOWANCE_MS;
  const claimAuthorityWindowMsMax = Math.max(
    APIFY_SOLD_COORDINATION_ALLOWANCE_MS,
    Math.min(
      APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS_DEFAULT,
      Math.floor(pricingWindowMs / 4),
    ),
  );
  const claimAuthorityWindowMsMin = Math.min(
    APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS_MIN,
    claimAuthorityWindowMsMax,
  );
  const claimAuthorityWindowMs = Math.max(
    claimAuthorityWindowMsMin,
    Math.min(
      claimAuthorityWindowMsMax,
      positiveNumber(
        options.claimAuthorityWindowMs ??
          process.env.APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS,
        APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS_DEFAULT,
      ),
    ),
  );
  const claimAuthorityHeartbeatMs = Math.max(
    APIFY_SOLD_WINNER_STORE_POLL_MS,
    Math.floor(claimAuthorityWindowMs / 3),
  );
  const staleDays = positiveNumber(
    options.staleDays ?? process.env.EBAY_SOLD_STALE_DAYS,
    SOLD_STALE_DAYS_DEFAULT,
  );
  const halfLifeDays = positiveNumber(
    options.halfLifeDays ?? process.env.EBAY_SOLD_HALFLIFE_DAYS,
    SOLD_HALFLIFE_DAYS_DEFAULT,
  );
  const circuitFailureThreshold = positiveInteger(
    options.circuitFailureThreshold,
    APIFY_SOLD_CIRCUIT_FAILURE_THRESHOLD_DEFAULT,
  );
  const circuitCooldownMs = positiveNumber(
    options.circuitCooldownMs,
    APIFY_SOLD_CIRCUIT_COOLDOWN_MS_DEFAULT,
  );
  const cache = options.cache;
  const claimCostFence =
    cache?.scope === "shared" && typeof cache.claim === "function"
      ? cache.claim.bind(cache)
      : null;
  const getClaimOwner =
    cache?.scope === "shared" && typeof cache.getClaimOwner === "function"
      ? cache.getClaimOwner.bind(cache)
      : null;
  const getClaimAuthority =
    cache?.scope === "shared" && typeof cache.getClaimAuthority === "function"
      ? cache.getClaimAuthority.bind(cache)
      : null;
  const refreshClaimAuthority =
    cache?.scope === "shared" &&
    typeof cache.refreshClaimAuthority === "function"
      ? cache.refreshClaimAuthority.bind(cache)
      : null;
  const terminateClaimAuthority =
    cache?.scope === "shared" &&
    typeof cache.terminateClaimAuthority === "function"
      ? cache.terminateClaimAuthority.bind(cache)
      : null;
  const hasClaimAuthorityProtocol =
    getClaimOwner != null &&
    getClaimAuthority != null &&
    refreshClaimAuthority != null &&
    terminateClaimAuthority != null;
  const winnerObservationPollMsMax = hasClaimAuthorityProtocol
    ? Math.max(
        APIFY_SOLD_COORDINATION_ALLOWANCE_MS,
        Math.min(
          claimAuthorityHeartbeatMs,
          APIFY_SOLD_WINNER_OBSERVATION_POLL_MS_MAX,
        ),
      )
    : APIFY_SOLD_COORDINATION_ALLOWANCE_MS;
  const now = options.now;
  const emitDiagnostic = options.emitDiagnostic ?? logEvent;
  const runActor = options.runActor ?? createDefaultApifySoldActorRunner(token);
  const runtimeState = runtimeStateFor(cache);
  const inFlight = runtimeState.inFlight;
  const circuit = circuitStateFor(
    runtimeState,
    JSON.stringify({ actorId, actorBuild }),
  );

  const queryFor = (signal: ItemSignal): string | null => buildSoldSearchQuery(signal);

  function requestFor(query: string, maxItems: number): ApifySoldRunRequest {
    return {
      actorId,
      build: actorBuild,
      input: {
        keywords: [query],
        count: maxItems,
        daysToScrape,
        ebaySite: "ebay.com",
        sortOrder: "endedRecently",
        itemLocation: "default",
        itemCondition: "any",
        includeCompletedListings: true,
      },
      maxItems,
      maxTotalChargeUsd,
      timeoutSecs,
      waitSecs,
      requestRetries,
      restartOnError: false,
    };
  }

  function cacheKey(query: string, signal: ItemSignal): string {
    return JSON.stringify({
      actorId,
      actorBuild,
      query,
      retrievalPolicy: "initial-10-expand-20-v1",
      daysToScrape,
      matcherSignal: {
        isbn: signal.isbn?.trim() ?? "",
        upc: signal.upc?.trim() ?? "",
        brand: signal.brand?.trim() ?? "",
        model: signal.model?.trim() ?? "",
        category: signal.category?.trim() ?? "",
        conditionKnown: signal.conditionKnown === true,
        condition: signal.condition?.trim() ?? "",
        resolvedName: signal.resolvedName?.trim() ?? "",
        specs: signal.specs?.map((spec) => spec.trim()) ?? [],
      },
    });
  }

  async function readCache(
    key: string,
    pricingDeadline: number,
  ): Promise<ApifySoldComp[] | null> {
    if (!cache) return null;
    try {
      const cacheRead = await settleBeforeApifyPricingDeadline(
        (abortSignal) => cache.get(key, abortSignal),
        pricingDeadline,
      );
      if (cacheRead === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
        emitDiagnostic("pricing.apify_sold.cache_error", {
          op: "get",
          reason: "timeout",
        });
        return null;
      }
      return cacheRead;
    } catch {
      emitDiagnostic("pricing.apify_sold.cache_error", { op: "get", reason: "unavailable" });
      return null;
    }
  }

  async function waitForClaimWinner(
    key: string,
    pricingDeadline: number,
  ): Promise<ApifySoldComp[] | null> {
    if (!cache) return null;
    let expectedOwner: string | null = null;
    let delayMs = 0;
    while (true) {
      if (delayMs > 0) {
        const remainingMs = pricingDeadline - Date.now();
        if (remainingMs <= 0) break;
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(delayMs, Math.max(1, Math.floor(remainingMs / 2))),
          ),
        );
      }
      const handoffOperationDeadline = hasClaimAuthorityProtocol
        ? Math.min(pricingDeadline, Date.now() + claimAuthorityWindowMs)
        : pricingDeadline;
      const handedOff = await readCache(key, handoffOperationDeadline);
      if (handedOff != null) return handedOff;
      if (hasClaimAuthorityProtocol) {
        try {
          if (expectedOwner == null) {
            const observedOwner = await settleBeforeApifyPricingDeadline(
              (abortSignal) => getClaimOwner(key, abortSignal),
              handoffOperationDeadline,
            );
            if (
              observedOwner === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED ||
              observedOwner == null
            ) {
              emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
                reason: "claim-authority-invalid",
              });
              return null;
            }
            expectedOwner = observedOwner;
          }
          const observedAuthority = await settleBeforeApifyPricingDeadline(
            (abortSignal) => getClaimAuthority(key, abortSignal),
            handoffOperationDeadline,
          );
          if (
            observedAuthority === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED ||
            observedAuthority == null ||
            observedAuthority.ownerToken !== expectedOwner ||
            observedAuthority.ownerToken.length === 0 ||
            (observedAuthority.state !== "live" &&
              observedAuthority.state !== "terminal") ||
            !Number.isFinite(observedAuthority.updatedAt) ||
            observedAuthority.updatedAt >
              Date.now() + APIFY_SOLD_CLAIM_AUTHORITY_CLOCK_SKEW_MS
          ) {
            emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
              reason: "claim-authority-invalid",
            });
            return null;
          }
          if (observedAuthority.state === "terminal") {
            emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
              reason: "claim-authority-terminal",
            });
            return null;
          }
          if (
            Date.now() - observedAuthority.updatedAt >= claimAuthorityWindowMs
          ) {
            emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
              reason: "claim-authority-stale",
            });
            return null;
          }
        } catch {
          emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
            reason: "claim-authority-unavailable",
          });
          return null;
        }
      }
      if (Date.now() >= pricingDeadline) break;
      delayMs =
        delayMs === 0
          ? APIFY_SOLD_WINNER_STORE_POLL_MS
          : Math.min(delayMs * 2, winnerObservationPollMsMax);
    }
    emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
      reason: "handoff-timeout",
    });
    return null;
  }

  function maintainClaimAuthority(
    key: string,
    ownerToken: string,
    pricingDeadline: number,
  ): () => Promise<void> {
    if (!hasClaimAuthorityProtocol) return async () => undefined;
    const cancellation = new AbortController();
    const heartbeat = (async () => {
      while (
        await delayBeforeApifyPricingDeadline(
          claimAuthorityHeartbeatMs,
          pricingDeadline,
          cancellation.signal,
        )
      ) {
        try {
          const refreshed = await settleBeforeApifyPricingDeadline(
            (abortSignal) =>
              refreshClaimAuthority(key, ownerToken, abortSignal),
            pricingDeadline,
            cancellation.signal,
          );
          if (
            refreshed === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED ||
            refreshed !== true
          ) {
            return;
          }
        } catch {
          return;
        }
      }
    })();
    return async () => {
      cancellation.abort();
      await heartbeat;
    };
  }

  async function establishClaimAuthority(
    key: string,
    ownerToken: string,
    pricingDeadline: number,
  ): Promise<boolean> {
    if (!hasClaimAuthorityProtocol) return true;
    try {
      const refreshed = await settleBeforeApifyPricingDeadline(
        (abortSignal) =>
          refreshClaimAuthority(key, ownerToken, abortSignal),
        Math.min(
          pricingDeadline,
          Date.now() + APIFY_SOLD_COORDINATION_ALLOWANCE_MS,
        ),
      );
      if (
        refreshed === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED ||
        refreshed !== true
      ) {
        emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
          reason: "claim-authority-refresh-unconfirmed",
        });
        return false;
      }
      return true;
    } catch {
      emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
        reason: "claim-authority-refresh-unavailable",
      });
      return false;
    }
  }

  async function markClaimAuthorityTerminal(
    key: string,
    ownerToken: string,
    pricingDeadline: number,
  ): Promise<void> {
    if (!hasClaimAuthorityProtocol) return;
    try {
      const terminated = await settleBeforeApifyPricingDeadline(
        (abortSignal) =>
          terminateClaimAuthority(key, ownerToken, abortSignal),
        pricingDeadline,
      );
      if (
        terminated === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED ||
        terminated !== true
      ) {
        emitDiagnostic("pricing.apify_sold.cache_error", {
          op: "claim-authority-terminal",
          reason: "unconfirmed",
        });
      }
    } catch {
      emitDiagnostic("pricing.apify_sold.cache_error", {
        op: "claim-authority-terminal",
        reason: "unavailable",
      });
    }
  }

  async function claimOrObserveExactOwner(
    key: string,
    ownerToken: string,
    pricingDeadline: number,
  ): Promise<boolean | typeof APIFY_SOLD_PRICING_DEADLINE_EXCEEDED> {
    if (!claimCostFence) return APIFY_SOLD_PRICING_DEADLINE_EXCEEDED;
    if (!getClaimOwner) {
      return settleBeforeApifyPricingDeadline(
        (abortSignal) => claimCostFence(key, abortSignal, ownerToken),
        pricingDeadline,
      );
    }

    const cancellation = new AbortController();
    try {
      const ownerObservationDeadline = hasClaimAuthorityProtocol
        ? Math.min(
            pricingDeadline,
            Date.now() + APIFY_SOLD_COORDINATION_ALLOWANCE_MS,
          )
        : pricingDeadline;
      const claimAttempt = settleBeforeApifyPricingDeadline(
        (abortSignal) => claimCostFence(key, abortSignal, ownerToken),
        ownerObservationDeadline,
        cancellation.signal,
      );
      const claimResponse = hasClaimAuthorityProtocol
        ? claimAttempt.catch(
            (): typeof APIFY_SOLD_CLAIM_RESPONSE_REJECTED =>
              APIFY_SOLD_CLAIM_RESPONSE_REJECTED,
          )
        : claimAttempt;
      const ownerObservation = (async (): Promise<
        | boolean
        | typeof APIFY_SOLD_PRICING_DEADLINE_EXCEEDED
      > => {
        if (
          !(await delayBeforeApifyPricingDeadline(
            0,
            ownerObservationDeadline,
            cancellation.signal,
          ))
        ) {
          return APIFY_SOLD_PRICING_DEADLINE_EXCEEDED;
        }

        let delayMs = APIFY_SOLD_WINNER_STORE_POLL_MS;
        while (!cancellation.signal.aborted) {
          try {
            const observedOwner = await settleBeforeApifyPricingDeadline(
              (abortSignal) => getClaimOwner(key, abortSignal),
              ownerObservationDeadline,
              cancellation.signal,
            );
            if (observedOwner === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
              return observedOwner;
            }
            if (observedOwner === ownerToken) return true;
          } catch {
            // A later bounded observation may still prove this exact owner.
          }

          const remainingMs = ownerObservationDeadline - Date.now();
          if (remainingMs <= 0) break;
          const finalReadAllowanceMs =
            APIFY_SOLD_WINNER_CACHE_READ_BUDGET_MS +
            APIFY_SOLD_DEADLINE_MARGIN_MS;
          if (remainingMs <= finalReadAllowanceMs) {
            await delayBeforeApifyPricingDeadline(
              Number.MAX_SAFE_INTEGER,
              ownerObservationDeadline,
              cancellation.signal,
            );
            break;
          }
          if (
            !(await delayBeforeApifyPricingDeadline(
              Math.min(delayMs, remainingMs - finalReadAllowanceMs),
              ownerObservationDeadline,
              cancellation.signal,
            ))
          ) {
            break;
          }
          delayMs = Math.min(delayMs * 2, APIFY_SOLD_COORDINATION_ALLOWANCE_MS);
        }
        return APIFY_SOLD_PRICING_DEADLINE_EXCEEDED;
      })();

      const first = await Promise.race([claimResponse, ownerObservation]);
      if (
        first === APIFY_SOLD_CLAIM_RESPONSE_REJECTED ||
        (hasClaimAuthorityProtocol &&
          first === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED)
      ) {
        return await ownerObservation;
      }
      return first;
    } finally {
      cancellation.abort();
    }
  }

  async function writeCache(
    key: string,
    comps: ApifySoldComp[],
    pricingDeadline: number,
  ): Promise<"stored" | "unconfirmed"> {
    if (!cache) return "stored";
    const cancellation = new AbortController();
    let storeFailureLogged = false;
    try {
      const storeOutcome = settleBeforeApifyPricingDeadline(
        (abortSignal) => cache.set(key, comps, abortSignal),
        pricingDeadline,
        cancellation.signal,
      ).then(
        (result): "stored" | "unconfirmed" =>
          result === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED
            ? "unconfirmed"
            : "stored",
        () => {
          storeFailureLogged = true;
          emitDiagnostic("pricing.apify_sold.cache_error", {
            op: "set",
            reason: "unavailable",
          });
          return new Promise<never>(() => undefined);
        },
      );

      const observationOutcome = (async (): Promise<"stored" | "unconfirmed"> => {
        let pollMs = APIFY_SOLD_WINNER_STORE_POLL_MS;
        let observationFailureLogged = false;
        if (
          !(await delayBeforeApifyPricingDeadline(
            0,
            pricingDeadline,
            cancellation.signal,
          ))
        ) {
          return "unconfirmed";
        }

        while (!cancellation.signal.aborted) {
          try {
            const observed = await settleBeforeApifyPricingDeadline(
              (abortSignal) => cache.get(key, abortSignal),
              pricingDeadline,
              cancellation.signal,
            );
            if (observed === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
              return "unconfirmed";
            }
            if (observed != null && sameApifySoldComps(observed, comps)) {
              return "stored";
            }
          } catch {
            if (!observationFailureLogged) {
              observationFailureLogged = true;
              emitDiagnostic("pricing.apify_sold.cache_error", {
                op: "get",
                reason: "unavailable",
              });
            }
          }

          const remainingMs = pricingDeadline - Date.now();
          const finalReadAllowanceMs =
            APIFY_SOLD_WINNER_CACHE_READ_BUDGET_MS + APIFY_SOLD_DEADLINE_MARGIN_MS;
          if (remainingMs <= finalReadAllowanceMs) {
            return "unconfirmed";
          }
          if (
            !(await delayBeforeApifyPricingDeadline(
              Math.min(
                pollMs,
                remainingMs - finalReadAllowanceMs,
              ),
              pricingDeadline,
              cancellation.signal,
            ))
          ) {
            return "unconfirmed";
          }
          pollMs = Math.min(pollMs * 2, APIFY_SOLD_COORDINATION_ALLOWANCE_MS);
        }
        return "unconfirmed";
      })();

      const outcome = await Promise.race([storeOutcome, observationOutcome]);
      if (outcome === "unconfirmed" && !storeFailureLogged) {
        emitDiagnostic("pricing.apify_sold.cache_error", {
          op: "set",
          reason: "timeout",
        });
      }
      return outcome;
    } finally {
      cancellation.abort();
    }
  }

  function recordFailure(reason: string): void {
    circuit.consecutiveFailures += 1;
    emitDiagnostic("pricing.apify_sold.actor_failed", { reason });
    if (circuit.consecutiveFailures >= circuitFailureThreshold) {
      circuit.openUntil = (now?.() ?? Date.now()) + circuitCooldownMs;
    }
  }

  async function runBatch(
    query: string,
    maxItems: number,
    pricingDeadline: number,
  ): Promise<ApifySoldComp[] | null> {
    if (Date.now() >= pricingDeadline) return null;
    try {
      const actorResult = await settleBeforeApifyPricingDeadline(
        () => runActor(requestFor(query, maxItems)),
        pricingDeadline,
      );
      if (actorResult === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
        recordFailure("request-timeout");
        return null;
      }
      const result = actorResult;
      if (result.status !== "SUCCEEDED") {
        recordFailure(boundedStatus(result.status));
        return null;
      }
      const comps = normalizeApifySoldItems(result.items, maxItems);
      circuit.consecutiveFailures = 0;
      circuit.openUntil = 0;
      return comps;
    } catch {
      recordFailure("request-failed");
      return null;
    }
  }

  async function fetchAndCache(
    key: string,
    query: string,
    signal: ItemSignal,
    pricingDeadline: number,
  ): Promise<ApifySoldComp[] | null> {
    const initial = await runBatch(
      query,
      APIFY_SOLD_INITIAL_RESULTS,
      pricingDeadline,
    );
    if (initial == null) {
      return (await writeCache(key, [], pricingDeadline)) === "unconfirmed"
        ? null
        : [];
    }

    let combined = normalizeEbaySoldCompUrls(initial);
    const initialEvidence = selectSoldCompEvidence(combined, signal);
    if (initialEvidence.anchors.length < APIFY_SOLD_EXPANSION_THRESHOLD) {
      const expanded = await runBatch(
        query,
        APIFY_SOLD_MAX_RESULTS_DEFAULT,
        pricingDeadline,
      );
      if (expanded != null) {
        combined = normalizeEbaySoldCompUrls([...expanded, ...combined]);
      }
    }
    return (await writeCache(key, combined, pricingDeadline)) === "unconfirmed"
      ? null
      : combined;
  }

  async function loadComps(
    query: string,
    signal: ItemSignal,
    pricingDeadline: number,
  ): Promise<ApifySoldComp[] | null> {
    if (!cache || !claimCostFence) {
      emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
        reason: "shared-cache-required",
      });
      return null;
    }
    const key = cacheKey(query, signal);
    let cached: ApifySoldComp[] | null;
    try {
      const cacheRead = await settleBeforeApifyPricingDeadline(
        (abortSignal) => cache.get(key, abortSignal),
        pricingDeadline,
      );
      if (cacheRead === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
        emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
          reason: "cache-read-timeout",
        });
        return null;
      }
      cached = cacheRead;
    } catch {
      emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
        reason: "cache-read-failed",
      });
      return null;
    }
    if (cached != null) return cached;

    const clock = now?.() ?? Date.now();
    if (clock < circuit.openUntil) {
      emitDiagnostic("pricing.apify_sold.circuit_open", {
        retryAfterMs: Math.max(0, circuit.openUntil - clock),
      });
      return null;
    }

    const existing = inFlight.get(key);
    if (existing) {
      const joined = await settleBeforeApifyPricingDeadline(
        () => existing,
        pricingDeadline,
      );
      if (joined === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
        emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
          reason: "in-flight-timeout",
        });
        return null;
      }
      return joined;
    }
    const pending = (async () => {
      let claimed: boolean;
      const claimOwnerToken = globalThis.crypto.randomUUID();
      try {
        const claimResult = await claimOrObserveExactOwner(
          key,
          claimOwnerToken,
          pricingDeadline,
        );
        if (claimResult === APIFY_SOLD_PRICING_DEADLINE_EXCEEDED) {
          emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
            reason: "claim-timeout",
          });
          return null;
        }
        claimed = claimResult;
      } catch {
        emitDiagnostic("pricing.apify_sold.cost_fence_unavailable", {
          reason: "claim-failed",
        });
        return null;
      }
      if (!claimed) {
        return waitForClaimWinner(key, pricingDeadline);
      }
      const terminalWriteReserveMs = APIFY_SOLD_COORDINATION_ALLOWANCE_MS;
      const ownerWorkDeadline = hasClaimAuthorityProtocol
        ? pricingDeadline - terminalWriteReserveMs
        : pricingDeadline;
      if (
        !(await establishClaimAuthority(
          key,
          claimOwnerToken,
          ownerWorkDeadline,
        ))
      ) {
        return null;
      }
      const stopMaintainingAuthority = maintainClaimAuthority(
        key,
        claimOwnerToken,
        ownerWorkDeadline,
      );
      try {
        return await fetchAndCache(
          key,
          query,
          signal,
          ownerWorkDeadline,
        );
      } finally {
        await stopMaintainingAuthority();
        await markClaimAuthorityTerminal(
          key,
          claimOwnerToken,
          pricingDeadline,
        );
      }
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  return {
    tier: "ebay-sold",
    canHandle(signal) {
      return active && queryFor(signal) != null;
    },
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!active) return null;
      const query = queryFor(signal);
      if (!query) return null;
      const pricingDeadline = Date.now() + pricingWindowMs;
      const comps = await loadComps(query, signal, pricingDeadline);
      if (comps == null) return null;

      const evidence = selectSoldCompEvidence(
        normalizeEbaySoldCompUrls(comps),
        signal,
      );
      // Retrieval is Actor-specific; every evidence decision after canonical
      // matching runs through the one shared finalization seam (#363).
      const clock = now?.();
      return finalizeVerifiedSoldResult(evidence, {
        ...(clock != null ? { now: clock } : {}),
        staleDays,
        halfLifeDays,
      });
    },
  };
}

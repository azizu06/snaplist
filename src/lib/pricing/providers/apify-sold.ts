import { ApifyClient } from "apify-client";
import type { TtlCache } from "../comp-cache";
import {
  selectFreshComps,
  SOLD_HALFLIFE_DAYS_DEFAULT,
  SOLD_STALE_DAYS_DEFAULT,
} from "../freshness";
import { selectSoldCompEvidence } from "../sold-comp-matcher";
import type { ItemSignal, PriceResult, PricingProvider } from "../types";
import { logEvent, type LogFields } from "../../observability";
import {
  buildSoldSearchQuery,
  canonicalEbayItemUrl,
  EBAY_SOLD_MIN_COMPS,
  normalizeEbaySoldCompUrls,
  synthesizeSoldResult,
  type EbaySoldComp,
} from "./ebay-sold";

/** The exact Caffein Dev Actor and build evaluated by issues #188/#198. */
export const APIFY_SOLD_ACTOR_ID = "oTtB3VgfuE9GtxQt2";
export const APIFY_SOLD_ACTOR_BUILD_DEFAULT = "1.18.3";
export const APIFY_SOLD_MAX_RESULTS_DEFAULT = 25;
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

export interface ApifySoldComp extends EbaySoldComp {
  isBestOfferAccepted?: boolean;
  priceDisclosure?: "displayed-sold-price" | "asking-price-not-accepted-amount";
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
  maxResults?: number;
  daysToScrape?: number;
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
  waitSecs?: number;
  requestRetries?: number;
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

/**
 * Normalize untrusted Actor rows into the provider-neutral sold-comp contract.
 * Seller identity, images, item IDs, raw payload fields, and non-USD prices never
 * cross this boundary. Best Offer asking prices remain labeled so the merged
 * matcher can reject them rather than silently treating them as accepted prices.
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

    seen.add(url);
    normalized.push({
      url,
      title,
      price,
      ...(conditionText ? { condition: conditionText } : {}),
      ...(soldAt != null ? { soldAt } : {}),
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
  const enabled = options.enabled ?? apifySoldConfigured();
  const active = enabled && token.length > 0;
  const actorId = options.actorId?.trim() || APIFY_SOLD_ACTOR_ID;
  const actorBuild =
    options.actorBuild?.trim() ||
    process.env.APIFY_SOLD_ACTOR_BUILD?.trim() ||
    APIFY_SOLD_ACTOR_BUILD_DEFAULT;
  const maxResults = Math.min(
    APIFY_SOLD_MAX_RESULTS_DEFAULT,
    positiveInteger(
      options.maxResults ?? process.env.APIFY_SOLD_MAX_RESULTS,
      APIFY_SOLD_MAX_RESULTS_DEFAULT,
    ),
  );
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

  function requestFor(query: string): ApifySoldRunRequest {
    return {
      actorId,
      build: actorBuild,
      input: {
        keywords: [query],
        count: maxResults,
        daysToScrape,
        ebaySite: "ebay.com",
        sortOrder: "endedRecently",
        itemLocation: "default",
        itemCondition: "any",
        includeCompletedListings: true,
      },
      maxItems: maxResults,
      maxTotalChargeUsd,
      timeoutSecs,
      waitSecs,
      requestRetries,
      restartOnError: false,
    };
  }

  function cacheKey(query: string): string {
    return JSON.stringify({ actorId, actorBuild, query, maxResults, daysToScrape });
  }

  async function readCache(key: string): Promise<ApifySoldComp[] | null> {
    if (!cache) return null;
    try {
      return await cache.get(key);
    } catch {
      emitDiagnostic("pricing.apify_sold.cache_error", { op: "get", reason: "unavailable" });
      return null;
    }
  }

  async function writeCache(key: string, comps: ApifySoldComp[]): Promise<void> {
    if (!cache) return;
    try {
      await cache.set(key, comps);
    } catch {
      emitDiagnostic("pricing.apify_sold.cache_error", { op: "set", reason: "unavailable" });
    }
  }

  function recordFailure(reason: string): void {
    circuit.consecutiveFailures += 1;
    emitDiagnostic("pricing.apify_sold.actor_failed", { reason });
    if (circuit.consecutiveFailures >= circuitFailureThreshold) {
      circuit.openUntil = (now?.() ?? Date.now()) + circuitCooldownMs;
    }
  }

  async function fetchAndCache(key: string, query: string): Promise<ApifySoldComp[] | null> {
    try {
      const result = await runActor(requestFor(query));
      if (result.status !== "SUCCEEDED") {
        recordFailure(boundedStatus(result.status));
        return null;
      }
      const comps = normalizeApifySoldItems(result.items, maxResults);
      circuit.consecutiveFailures = 0;
      circuit.openUntil = 0;
      await writeCache(key, comps);
      return comps;
    } catch {
      recordFailure("request-failed");
      return null;
    }
  }

  async function loadComps(query: string): Promise<ApifySoldComp[] | null> {
    const key = cacheKey(query);
    const cached = await readCache(key);
    if (cached != null) return cached;

    const clock = now?.() ?? Date.now();
    if (clock < circuit.openUntil) {
      emitDiagnostic("pricing.apify_sold.circuit_open", {
        retryAfterMs: Math.max(0, circuit.openUntil - clock),
      });
      return null;
    }

    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = fetchAndCache(key, query).finally(() => {
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
      const comps = await loadComps(query);
      if (comps == null) return null;

      const normalizedComps = normalizeEbaySoldCompUrls(comps);
      const evidence = selectSoldCompEvidence(normalizedComps, signal);
      const weights = new Map(evidence.anchors.map(({ comp, score }) => [comp, score]));
      const clock = now?.();
      const anchors = evidence.anchors.map(({ comp }) => comp);
      const fresh = clock == null ? anchors : selectFreshComps(anchors, clock, staleDays);
      if (fresh.length < EBAY_SOLD_MIN_COMPS) return null;

      return synthesizeSoldResult(fresh, {
        ...(clock != null ? { now: clock, halfLifeDays } : {}),
        evidenceWeight: (comp) => weights.get(comp as ApifySoldComp) ?? 1,
      });
    },
  };
}

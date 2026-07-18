import catalog from "./catalog.v1.json";
import { z } from "zod";
import {
  loadedReviewSnapshotItem,
  type ReviewSnapshot,
} from "@/lib/pipeline/review-snapshot";
import {
  SCOUT_GUIDANCE_CONTRACT_VERSION,
  scoutGuidanceCatalogSchema,
  type ScoutGuidanceDefinition,
  type ScoutGuidanceTrustedSource,
} from "./contract";

export { SCOUT_GUIDANCE_CONTRACT_VERSION } from "./contract";

export type ScoutGuidanceState = keyof typeof catalog.states;

export class ScoutGuidanceContractError extends Error {
  readonly name = "ScoutGuidanceContractError";

  constructor(
    readonly code:
      | "missing-substitution"
      | "untrusted-substitution"
      | "invalid-substitution"
      | "unsupported-contract-version"
      | "unsupported-state",
    readonly state: string,
    readonly substitutionKey: string,
    message: string,
    readonly contractVersion?: string,
  ) {
    super(message);
  }
}

export class ScoutGuidanceFactError extends Error {
  readonly name = "ScoutGuidanceFactError";

  constructor(
    readonly code:
      | "untrusted-durable-item-record"
      | "missing-item-display-name",
    message: string,
  ) {
    super(message);
  }
}

declare const verifiedFactType: unique symbol;
const verifiedFacts = new WeakSet<object>();

export type VerifiedScoutGuidanceFact = Readonly<{
  source: ScoutGuidanceTrustedSource;
  reference: string;
  value: string | number;
  [verifiedFactType]: true;
}>;

const uuidSchema = z.string().uuid();
const durableItemRecordSchema = z.object({
  id: uuidSchema,
  review_revision: uuidSchema,
  attributes: z.unknown(),
});
const durableItemAttributesSchema = z.object({
  title: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  category: z.string().optional(),
});

function verifiedFact(
  source: ScoutGuidanceTrustedSource,
  reference: string,
  value: string | number,
): VerifiedScoutGuidanceFact {
  const fact = Object.freeze({
    source,
    reference,
    value,
  }) as VerifiedScoutGuidanceFact;
  verifiedFacts.add(fact);
  return fact;
}

function isVerifiedFact(value: unknown): value is VerifiedScoutGuidanceFact {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedFacts.has(value)
  );
}

/**
 * Construct the only item-name fact accepted by Scout guidance from the exact
 * object returned by the tenant-scoped review snapshot RPC seam. Object
 * identity is checked before the display name and provenance are derived.
 */
export function verifiedItemDisplayNameFromDurableRecord(
  snapshot: ReviewSnapshot,
): VerifiedScoutGuidanceFact {
  const loadedItem = loadedReviewSnapshotItem(snapshot);
  if (!loadedItem) {
    throw new ScoutGuidanceFactError(
      "untrusted-durable-item-record",
      "Durable item facts must come from the tenant-scoped review snapshot loader.",
    );
  }
  const durableRecord = durableItemRecordSchema.parse(loadedItem);
  const attributes = durableItemAttributesSchema.parse(
    durableRecord.attributes ?? {},
  );
  const value =
    attributes.title ||
    [attributes.brand, attributes.model].filter(Boolean).join(" ") ||
    attributes.category;
  if (!value) {
    throw new ScoutGuidanceFactError(
      "missing-item-display-name",
      "The durable item has no approved display-name fact for this template.",
    );
  }
  return verifiedFact(
    "durable-item-record",
    `item:${durableRecord.id}:review-revision:${durableRecord.review_revision}`,
    value,
  );
}

export function verifiedCapturedPhotoCount(input: {
  captureSessionId: string;
  capturedPhotoCount: number;
}): VerifiedScoutGuidanceFact {
  return verifiedFact(
    "capture-session",
    `capture-session:${uuidSchema.parse(input.captureSessionId)}`,
    input.capturedPhotoCount,
  );
}

export function verifiedPriceEvidence(input: {
  recommendationId: string;
  soldCompCount: number;
  windowDays: number;
}): Readonly<{
  soldCompCount: VerifiedScoutGuidanceFact;
  windowDays: VerifiedScoutGuidanceFact;
}> {
  const reference = `price-recommendation:${uuidSchema.parse(input.recommendationId)}`;
  return Object.freeze({
    soldCompCount: verifiedFact(
      "price-recommendation",
      reference,
      input.soldCompCount,
    ),
    windowDays: verifiedFact("price-recommendation", reference, input.windowDays),
  });
}

export function verifiedUploadedPhotoCount(input: {
  runId: string;
  uploadedPhotoCount: number;
}): VerifiedScoutGuidanceFact {
  return verifiedFact(
    "durable-run",
    `run:${uuidSchema.parse(input.runId)}`,
    input.uploadedPhotoCount,
  );
}

const guidanceCatalog = scoutGuidanceCatalogSchema.parse(catalog);

export const SCOUT_GUIDANCE_STATES = Object.freeze(
  Object.keys(guidanceCatalog.states) as ScoutGuidanceState[],
);

export type ResolveScoutGuidanceRequest = {
  contractVersion: typeof SCOUT_GUIDANCE_CONTRACT_VERSION;
  state: ScoutGuidanceState;
  locale: string;
  substitutions: Record<string, VerifiedScoutGuidanceFact>;
};

export type ResolvedScoutGuidance = {
  contractVersion: typeof SCOUT_GUIDANCE_CONTRACT_VERSION;
  state: ScoutGuidanceState;
  requestedLocale: string;
  resolvedLocale: string;
  localeFallbackApplied: boolean;
  localeFallbackChain: string[];
  message: {
    title: string;
    body: string | null;
  };
  accessibility: {
    label: string;
    scoutAssetDecorative: true;
    meaningCompleteInText: true;
    statusNeverColorOnly: true;
  };
  guide: ScoutGuidanceDefinition["guide"];
};

function validatedSubstitutions(
  state: ScoutGuidanceState,
  definition: ScoutGuidanceDefinition,
  provided: Record<string, VerifiedScoutGuidanceFact>,
): Record<string, string> {
  const allowedKeys = new Set(definition.substitutions.map((rule) => rule.key));
  const unexpectedKey = Object.keys(provided).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) {
    throw new Error(`Substitution ${unexpectedKey} is not allowed for this guidance state.`);
  }

  return Object.fromEntries(
    definition.substitutions.map((rule) => {
      const substitution = provided[rule.key];
      if (!substitution) {
        throw new ScoutGuidanceContractError(
          "missing-substitution",
          state,
          rule.key,
          `Missing required substitution ${rule.key}.`,
        );
      }
      if (!isVerifiedFact(substitution)) {
        throw new ScoutGuidanceContractError(
          "untrusted-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} was not constructed at a verified fact boundary.`,
        );
      }
      if (!rule.trustedSources.includes(substitution.source)) {
        throw new ScoutGuidanceContractError(
          "untrusted-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} did not come from a trusted source.`,
        );
      }
      if (
        rule.valueType === "integer" &&
        (typeof substitution.value !== "number" ||
          !Number.isInteger(substitution.value) ||
          (rule.minimum !== undefined && substitution.value < rule.minimum) ||
          (rule.maximum !== undefined && substitution.value > rule.maximum))
      ) {
        throw new ScoutGuidanceContractError(
          "invalid-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} is outside its approved bounds.`,
        );
      }
      if (
        rule.valueType === "text" &&
        (typeof substitution.value !== "string" ||
          substitution.value.length === 0 ||
          substitution.value !== substitution.value.trim() ||
          (rule.maximumLength !== undefined &&
            substitution.value.length > rule.maximumLength) ||
          /[\u0000-\u001F\u007F{}<>]/.test(substitution.value))
      ) {
        throw new ScoutGuidanceContractError(
          "invalid-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} is outside its approved bounds.`,
        );
      }
      if (
        rule.referencePattern &&
        (!substitution.reference ||
          !new RegExp(rule.referencePattern).test(substitution.reference))
      ) {
        throw new ScoutGuidanceContractError(
          "invalid-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} is missing verified provenance.`,
        );
      }
      return [rule.key, String(substitution.value)];
    }),
  );
}

function renderTemplate(
  template: string,
  substitutions: Record<string, string>,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) => {
    const value = substitutions[key];
    if (value === undefined) {
      throw new Error(`Template requested missing substitution ${key}.`);
    }
    return value;
  });
}

function resolveLocale(requestedLocale: string): {
  resolvedLocale: string;
  fallbackChain: string[];
} {
  let canonicalLocale: string;
  let language: string | null = null;
  try {
    canonicalLocale = Intl.getCanonicalLocales(requestedLocale)[0];
    language = new Intl.Locale(canonicalLocale).language;
  } catch {
    canonicalLocale = requestedLocale;
  }

  const fallbackChain = [
    canonicalLocale,
    ...(language && language !== canonicalLocale ? [language] : []),
    guidanceCatalog.defaultLocale,
  ].filter((locale, index, locales) => locale && locales.indexOf(locale) === index);
  const resolvedLocale =
    fallbackChain.find((locale) =>
      Object.hasOwn(guidanceCatalog.locales, locale),
    ) ??
    guidanceCatalog.defaultLocale;

  return { resolvedLocale, fallbackChain };
}

export function resolveScoutGuidance(
  request: ResolveScoutGuidanceRequest,
): ResolvedScoutGuidance {
  if (request.contractVersion !== SCOUT_GUIDANCE_CONTRACT_VERSION) {
    throw new ScoutGuidanceContractError(
      "unsupported-contract-version",
      request.state,
      "",
      `Unsupported Scout guidance contract version ${request.contractVersion}.`,
      request.contractVersion,
    );
  }
  if (!Object.hasOwn(guidanceCatalog.states, request.state)) {
    throw new ScoutGuidanceContractError(
      "unsupported-state",
      request.state,
      "",
      `Unsupported Scout guidance state ${request.state}.`,
    );
  }
  const definition = guidanceCatalog.states[request.state];
  const localeResolution = resolveLocale(request.locale);
  const locale = guidanceCatalog.locales[localeResolution.resolvedLocale];
  const substitutions = validatedSubstitutions(
    request.state,
    definition,
    request.substitutions,
  );
  const copy = (key: string) => renderTemplate(locale[key], substitutions);

  return {
    contractVersion: SCOUT_GUIDANCE_CONTRACT_VERSION,
    state: request.state,
    requestedLocale: request.locale,
    resolvedLocale: localeResolution.resolvedLocale,
    localeFallbackApplied:
      localeResolution.fallbackChain[0] !== localeResolution.resolvedLocale,
    localeFallbackChain: localeResolution.fallbackChain,
    message: {
      title: copy(definition.copyKeys.title),
      body: definition.copyKeys.body ? copy(definition.copyKeys.body) : null,
    },
    accessibility: {
      label: copy(definition.copyKeys.accessibilityLabel),
      ...guidanceCatalog.accessibilityPolicy,
    },
    guide: {
      ...definition.guide,
      motion: { ...definition.guide.motion },
    },
  };
}

import catalog from "./catalog.v1.json";
import { z } from "zod";
import {
  SCOUT_GUIDANCE_CONTRACT_VERSION,
  canonicalizeScoutGuidanceLocale,
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
      | "invalid-locale"
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
    readonly code: "missing-item-display-name" | "unsafe-item-display-name",
    message: string,
  ) {
    super(message);
  }
}

declare const verifiedFactBrand: unique symbol;

export type VerifiedScoutGuidanceFact = Readonly<{
  source: ScoutGuidanceTrustedSource;
  reference: string;
  value: string | number;
  [verifiedFactBrand]: true;
}>;

const enrolledVerifiedFacts = new WeakMap<object, string>();

const uuidSchema = z.string().uuid();
const captureSessionProjectionSchema = z
  .object({
    id: uuidSchema,
    photos: z.array(z.object({ id: uuidSchema }).strict()).min(1).max(4),
  })
  .strict()
  .refine(
    (session) =>
      new Set(session.photos.map((photo) => photo.id)).size ===
      session.photos.length,
    "Capture-session photo identities must be unique.",
  );
const priceRecommendationProjectionSchema = z
  .object({
    id: uuidSchema,
    retainedSoldComps: z
      .array(
        z
          .object({
            id: uuidSchema,
            soldAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(99),
  })
  .strict()
  .refine(
    (recommendation) =>
      new Set(recommendation.retainedSoldComps.map((comp) => comp.id)).size ===
      recommendation.retainedSoldComps.length,
    "Retained sold-comp identities must be unique.",
  );
const durableRunProjectionSchema = z
  .object({
    id: uuidSchema,
    photos: z
      .array(
        z
          .object({
            id: uuidSchema,
            status: z.enum(["pending", "uploaded"]),
          })
          .strict(),
      )
      .max(4),
  })
  .strict()
  .refine(
    (run) =>
      new Set(run.photos.map((photo) => photo.id)).size === run.photos.length,
    "Durable-run photo identities must be unique.",
  );
const durableItemRecordSchema = z.object({
  id: uuidSchema,
  review_revision: uuidSchema,
  attributes: z.unknown(),
});
const durableItemAttributesSchema = z.object({
  brand: z.string().optional(),
  model: z.string().optional(),
  category: z.string().optional(),
});
const scoutItemDisplayNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim())
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ./'’&()+#-]*$/u);

function verifiedFact(
  semanticKey: string,
  source: ScoutGuidanceTrustedSource,
  reference: string,
  value: string | number,
): VerifiedScoutGuidanceFact {
  const fact = Object.freeze({
    source,
    reference,
    value,
  }) as VerifiedScoutGuidanceFact;
  enrolledVerifiedFacts.set(fact, semanticKey);
  return fact;
}

function isVerifiedFact(value: unknown): value is VerifiedScoutGuidanceFact {
  return (
    typeof value === "object" &&
    value !== null &&
    enrolledVerifiedFacts.has(value)
  );
}

/**
 * Construct the only item-name fact accepted by Scout guidance from an already
 * tenant-scoped durable item row. The display name and provenance are derived;
 * call sites cannot label arbitrary prose as a durable record fact.
 */
export function verifiedItemDisplayNameFromDurableRecord(record: {
  id: string;
  review_revision: string;
  attributes: unknown;
}): VerifiedScoutGuidanceFact {
  const durableRecord = durableItemRecordSchema.parse(record);
  const attributes = durableItemAttributesSchema.parse(
    durableRecord.attributes ?? {},
  );
  // Listing titles are generated copy. Scout accepts only the narrower
  // structured identity facts so arbitrary model prose cannot cross this seam.
  const candidate =
    [attributes.brand, attributes.model].filter(Boolean).join(" ") ||
    attributes.category;
  if (!candidate) {
    throw new ScoutGuidanceFactError(
      "missing-item-display-name",
      "The durable item has no bounded identity fact for Scout guidance.",
    );
  }
  const parsedCandidate = scoutItemDisplayNameSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    throw new ScoutGuidanceFactError(
      "unsafe-item-display-name",
      "The durable item name is outside Scout's bounded substitution grammar.",
    );
  }
  return verifiedFact(
    "itemDisplayName",
    "durable-item-record",
    `item:${durableRecord.id}:review-revision:${durableRecord.review_revision}`,
    parsedCandidate.data,
  );
}

export function verifiedCapturedPhotoCount(projection: {
  id: string;
  photos: ReadonlyArray<{ id: string }>;
}): VerifiedScoutGuidanceFact {
  const session = captureSessionProjectionSchema.parse(projection);
  return verifiedFact(
    "capturedPhotoCount",
    "capture-session",
    `capture-session:${session.id}`,
    session.photos.length,
  );
}

/** Derive price-evidence facts from the retained, dated sold-comp projection. */
export function verifiedPriceEvidence(projection: {
  id: string;
  retainedSoldComps: ReadonlyArray<{ id: string; soldAt: string }>;
}): Readonly<{
  soldCompCount: VerifiedScoutGuidanceFact;
  windowDays: VerifiedScoutGuidanceFact;
}> {
  const recommendation = priceRecommendationProjectionSchema.parse(projection);
  const soldDayIndexes = recommendation.retainedSoldComps.map((comp) => {
    const soldAt = new Date(comp.soldAt);
    return Date.UTC(
      soldAt.getUTCFullYear(),
      soldAt.getUTCMonth(),
      soldAt.getUTCDate(),
    ) / 86_400_000;
  });
  const windowDays = Math.max(...soldDayIndexes) - Math.min(...soldDayIndexes) + 1;
  const reference = `price-recommendation:${recommendation.id}`;
  return Object.freeze({
    soldCompCount: verifiedFact(
      "soldCompCount",
      "price-recommendation",
      reference,
      recommendation.retainedSoldComps.length,
    ),
    windowDays: verifiedFact(
      "windowDays",
      "price-recommendation",
      reference,
      windowDays,
    ),
  });
}

/** Derive uploaded progress from durable per-photo run state. */
export function verifiedUploadedPhotoCount(projection: {
  id: string;
  photos: ReadonlyArray<{
    id: string;
    status: "pending" | "uploaded";
  }>;
}): VerifiedScoutGuidanceFact {
  const run = durableRunProjectionSchema.parse(projection);
  return verifiedFact(
    "uploadedPhotoCount",
    "durable-run",
    `run:${run.id}`,
    run.photos.filter((photo) => photo.status === "uploaded").length,
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
      if (enrolledVerifiedFacts.get(substitution) !== rule.key) {
        throw new ScoutGuidanceContractError(
          "invalid-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} is bound to a different semantic fact.`,
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

function resolveLocale(canonicalLocale: string): {
  resolvedLocale: string;
  fallbackChain: string[];
} {
  const primaryLanguage = canonicalLocale.split("-", 1)[0];
  const language = /^[A-Za-z]{2,8}$/.test(primaryLanguage)
    ? primaryLanguage.toLowerCase()
    : null;

  const fallbackChain = [
    canonicalLocale,
    ...(language && language !== canonicalLocale ? [language] : []),
    guidanceCatalog.defaultLocale,
  ].filter((locale, index, locales) => locale && locales.indexOf(locale) === index);
  const resolvedLocale =
    fallbackChain.find((locale) => guidanceCatalog.locales[locale]) ??
    guidanceCatalog.defaultLocale;

  return { resolvedLocale, fallbackChain };
}

function pluralizedCopyKey(
  definition: ScoutGuidanceDefinition,
  slot: "body" | "accessibilityLabel",
  fallbackCopyKey: string,
  locale: string,
  substitutions: Record<string, string>,
): string {
  const pluralCopyKeys = definition.pluralCopyKeys;
  if (!pluralCopyKeys) return fallbackCopyKey;
  const selectorValue = Number(substitutions[pluralCopyKeys.selector]);
  let category: Intl.LDMLPluralRule;
  try {
    category = new Intl.PluralRules(locale).select(selectorValue);
  } catch {
    category = new Intl.PluralRules(guidanceCatalog.defaultLocale).select(
      selectorValue,
    );
  }
  return pluralCopyKeys[slot]?.[category] ?? fallbackCopyKey;
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
  const definition = guidanceCatalog.states[request.state];
  if (!definition) {
    throw new ScoutGuidanceContractError(
      "unsupported-state",
      request.state,
      "",
      `Unsupported Scout guidance state ${request.state}.`,
    );
  }
  const canonicalLocale = canonicalizeScoutGuidanceLocale(request.locale);
  if (!canonicalLocale) {
    throw new ScoutGuidanceContractError(
      "invalid-locale",
      request.state,
      "",
      `Invalid Scout guidance locale ${request.locale}.`,
    );
  }
  const localeResolution = resolveLocale(canonicalLocale);
  const locale = guidanceCatalog.locales[localeResolution.resolvedLocale];
  const substitutions = validatedSubstitutions(
    request.state,
    definition,
    request.substitutions,
  );
  const copy = (key: string) => renderTemplate(locale[key], substitutions);
  const bodyCopyKey = definition.copyKeys.body
    ? pluralizedCopyKey(
        definition,
        "body",
        definition.copyKeys.body,
        localeResolution.resolvedLocale,
        substitutions,
      )
    : null;
  const accessibilityCopyKey = pluralizedCopyKey(
    definition,
    "accessibilityLabel",
    definition.copyKeys.accessibilityLabel,
    localeResolution.resolvedLocale,
    substitutions,
  );

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
      body: bodyCopyKey ? copy(bodyCopyKey) : null,
    },
    accessibility: {
      label: copy(accessibilityCopyKey),
      ...guidanceCatalog.accessibilityPolicy,
    },
    guide: {
      ...definition.guide,
      motion: { ...definition.guide.motion },
    },
  };
}

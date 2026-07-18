import catalog from "./catalog.v1.json";
import { z } from "zod";
import {
  loadedReviewSnapshotItem,
  type ReviewSnapshot,
} from "@/lib/pipeline/review-snapshot";
import {
  acceptedCaptureProgressFacts,
  type AppendAcceptedPhotosResult,
} from "@/lib/capture-progress";
import {
  uploadedPhotoProgressFacts,
  type UploadProgressSnapshot,
} from "@/lib/upload-staging";
import {
  priceResultSchema,
  type PriceResult,
} from "@/lib/pricing";
import { trustedPriceEvidenceSnapshot } from "@/lib/pricing/approved-sold-provider";
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
      | "untrusted-capture-session"
      | "untrusted-upload-progress"
      | "untrusted-price-recommendation"
      | "missing-item-display-name"
      | "unsafe-item-display-name",
    message: string,
  ) {
    super(message);
  }
}

declare const verifiedFactType: unique symbol;
const verifiedFacts = new WeakSet<object>();
const verifiedFactKeys = new WeakMap<object, ScoutGuidanceSubstitutionKey>();
const verifiedFactGroups = new WeakMap<object, object>();

type ScoutGuidanceSubstitutionKey =
  | "capturedPhotoCount"
  | "itemDisplayName"
  | "soldCompCount"
  | "windowDays"
  | "uploadProgressSummary";

export type VerifiedScoutGuidanceFact = Readonly<{
  source: ScoutGuidanceTrustedSource;
  reference: string;
  value: string | number | UploadProgressValue;
  [verifiedFactType]: true;
}>;

type UploadProgressValue = Readonly<{
  uploadedPhotoCount: number;
  plannedPhotoCount: number | null;
}>;

const uuidSchema = z.string().uuid();
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
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ./'’&()+#-]*$/u)
  .refine(
    (value) =>
      !/\b(?:not\s+just|ignore|prompt|assistant|system|unlock|seamless|effortless|powerful)\b/i.test(
        value,
      ),
  );

function verifiedFact(
  key: ScoutGuidanceSubstitutionKey,
  source: ScoutGuidanceTrustedSource,
  reference: string,
  value: string | number | UploadProgressValue,
  group?: object,
): VerifiedScoutGuidanceFact {
  const fact = Object.freeze({
    source,
    reference,
    value,
  }) as VerifiedScoutGuidanceFact;
  verifiedFacts.add(fact);
  verifiedFactKeys.set(fact, key);
  if (group) verifiedFactGroups.set(fact, group);
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
  // `title` is free-form generated/listing copy. Scout substitutions stay on
  // the narrower structured-fact seam so #243 can own seller-copy policy
  // without generated prose leaking into this deterministic catalog.
  const candidate =
    [attributes.brand, attributes.model].filter(Boolean).join(" ") ||
    attributes.category;
  if (!candidate) {
    throw new ScoutGuidanceFactError(
      "missing-item-display-name",
      "The durable item has no approved display-name fact for this template.",
    );
  }
  const value = scoutItemDisplayNameSchema.safeParse(candidate);
  if (!value.success) {
    throw new ScoutGuidanceFactError(
      "unsafe-item-display-name",
      "The durable item name is outside Scout's bounded substitution grammar.",
    );
  }
  return verifiedFact(
    "itemDisplayName",
    "durable-item-record",
    `item:${durableRecord.id}:review-revision:${durableRecord.review_revision}`,
    value.data,
  );
}

export function verifiedCapturedPhotoCount(
  result: AppendAcceptedPhotosResult,
): VerifiedScoutGuidanceFact {
  const input = acceptedCaptureProgressFacts(result);
  if (!input) {
    throw new ScoutGuidanceFactError(
      "untrusted-capture-session",
      "Capture facts must come from the accepted-photo progress seam.",
    );
  }
  return verifiedFact(
    "capturedPhotoCount",
    "capture-session",
    `capture-session:${uuidSchema.parse(input.captureSessionId)}`,
    input.capturedPhotoCount,
  );
}

export function verifiedPriceEvidence(recommendationInput: PriceResult): Readonly<{
  soldCompCount: VerifiedScoutGuidanceFact;
  windowDays: VerifiedScoutGuidanceFact;
}> {
  const trustedSnapshot = trustedPriceEvidenceSnapshot(recommendationInput);
  const recommendation = priceResultSchema.safeParse(trustedSnapshot);
  const soldSources = recommendation.success
    ? recommendation.data.sources.filter((source) => source.kind === "sold-comp")
    : [];
  const uniqueSoldSourceCount = new Set(
    soldSources.map((source) => source.url),
  ).size;
  const soldProviders = new Set(
    soldSources.map((source) => source.soldProvider),
  );
  const observedAt = soldSources[0]?.observedAt ?? Number.NaN;
  const oldestSoldAt = Math.min(
    ...soldSources.map((source) => source.soldAt ?? Number.NaN),
  );
  const windowDays = Math.max(
    1,
    Math.ceil((observedAt - oldestSoldAt) / 86_400_000),
  );
  if (
    !recommendation.success ||
    soldSources.length === 0 ||
    uniqueSoldSourceCount !== soldSources.length ||
    soldProviders.size !== 1 ||
    soldProviders.has(undefined) ||
    !Number.isInteger(windowDays) ||
    windowDays > 365 ||
    soldSources.some(
      (source) =>
        source.soldAt === undefined ||
        !Number.isFinite(source.soldAt) ||
        source.observedAt !== observedAt ||
        source.soldAt > observedAt,
    )
  ) {
    throw new ScoutGuidanceFactError(
      "untrusted-price-recommendation",
      "Price facts require persisted, dated sold comps for the exact recommendation.",
    );
  }
  const reference = `price-recommendation:${crypto.randomUUID()}`;
  const group = Object.freeze({});
  return Object.freeze({
    soldCompCount: verifiedFact(
      "soldCompCount",
      "price-recommendation",
      reference,
      soldSources.length,
      group,
    ),
    windowDays: verifiedFact(
      "windowDays",
      "price-recommendation",
      reference,
      windowDays,
      group,
    ),
  });
}

export function formatUploadProgressSummary(input: {
  uploadedPhotoCount: number;
  plannedPhotoCount: number | null;
}, localizedCopy: Record<string, string> = guidanceCatalog.locales[
  guidanceCatalog.defaultLocale
]): string {
  const uploaded = z.number().int().min(0).max(4).parse(input.uploadedPhotoCount);
  const planned = z.number().int().min(1).max(4).nullable().parse(
    input.plannedPhotoCount,
  );
  const key =
    planned === null
      ? uploaded === 0
        ? "format.upload-progress.unknown-zero"
        : uploaded === 1
          ? "format.upload-progress.unknown-one"
          : "format.upload-progress.unknown-other"
      : planned === 1
        ? "format.upload-progress.known-one"
        : "format.upload-progress.known-other";
  const template = localizedCopy[key];
  if (!template) throw new Error(`Locale is missing copy key ${key}.`);
  return template
    .replaceAll("{uploadedPhotoCount}", String(uploaded))
    .replaceAll("{plannedPhotoCount}", String(planned));
}

export function verifiedUploadProgress(
  result: UploadProgressSnapshot,
): VerifiedScoutGuidanceFact {
  const input = uploadedPhotoProgressFacts(result);
  if (!input) {
    throw new ScoutGuidanceFactError(
      "untrusted-upload-progress",
      "Upload facts must come from the producer-owned per-photo attempt snapshot.",
    );
  }
  return verifiedFact(
    "uploadProgressSummary",
    "upload-progress",
    `upload-session:${uuidSchema.parse(input.uploadSessionId)}:entry:${input.entryIndex}`,
    Object.freeze({
      uploadedPhotoCount: input.uploadedPhotoCount,
      plannedPhotoCount: input.plannedPhotoCount,
    }),
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
): Record<string, string | UploadProgressValue> {
  const allowedKeys = new Set(definition.substitutions.map((rule) => rule.key));
  let relatedFactGroup: object | undefined;
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
      if (verifiedFactKeys.get(substitution) !== rule.key) {
        throw new ScoutGuidanceContractError(
          "untrusted-substitution",
          state,
          rule.key,
          `Substitution ${rule.key} was verified for a different semantic key.`,
        );
      }
      if (definition.substitutions.length > 1) {
        const factGroup = verifiedFactGroups.get(substitution);
        if (!factGroup || (relatedFactGroup && factGroup !== relatedFactGroup)) {
          throw new ScoutGuidanceContractError(
            "untrusted-substitution",
            state,
            rule.key,
            `Substitution ${rule.key} was verified for a different related-fact bundle.`,
          );
        }
        relatedFactGroup = factGroup;
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
        rule.valueType === "upload-progress" &&
        (!isUploadProgressValue(substitution.value) ||
          substitution.value.uploadedPhotoCount < 0 ||
          substitution.value.uploadedPhotoCount > 4 ||
          (substitution.value.plannedPhotoCount !== null &&
            (substitution.value.plannedPhotoCount < 1 ||
              substitution.value.plannedPhotoCount > 4 ||
              substitution.value.uploadedPhotoCount >
                substitution.value.plannedPhotoCount)))
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
      const renderedValue: string | UploadProgressValue =
        rule.valueType === "upload-progress" &&
        isUploadProgressValue(substitution.value)
          ? substitution.value
          : String(substitution.value);
      return [rule.key, renderedValue] as const;
    }),
  );
}

function renderTemplate(
  template: string,
  substitutions: Record<string, string | UploadProgressValue>,
  localizedCopy: Record<string, string>,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) => {
    const value = substitutions[key];
    if (value === undefined) {
      throw new Error(`Template requested missing substitution ${key}.`);
    }
    return typeof value === "object"
      ? formatUploadProgressSummary(value, localizedCopy)
      : value;
  });
}

function isUploadProgressValue(value: unknown): value is UploadProgressValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "uploadedPhotoCount" in value &&
    Number.isInteger(value.uploadedPhotoCount) &&
    "plannedPhotoCount" in value &&
    (value.plannedPhotoCount === null || Number.isInteger(value.plannedPhotoCount))
  );
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
  const copy = (key: string) =>
    renderTemplate(locale[key], substitutions, locale);

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

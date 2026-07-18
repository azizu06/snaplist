import catalog from "../../../docs/contracts/scout-guidance-v1.json";
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

type ScoutGuidanceSubstitution = {
  source: ScoutGuidanceTrustedSource;
  reference?: string;
  value: string | number;
};

const guidanceCatalog = scoutGuidanceCatalogSchema.parse(catalog);

export const SCOUT_GUIDANCE_STATES = Object.freeze(
  Object.keys(guidanceCatalog.states) as ScoutGuidanceState[],
);

export type ResolveScoutGuidanceRequest = {
  contractVersion: typeof SCOUT_GUIDANCE_CONTRACT_VERSION;
  state: ScoutGuidanceState;
  locale: string;
  substitutions: Record<string, ScoutGuidanceSubstitution>;
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
  provided: Record<string, ScoutGuidanceSubstitution>,
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
    fallbackChain.find((locale) => guidanceCatalog.locales[locale]) ??
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
  const definition = guidanceCatalog.states[request.state];
  if (!definition) {
    throw new ScoutGuidanceContractError(
      "unsupported-state",
      request.state,
      "",
      `Unsupported Scout guidance state ${request.state}.`,
    );
  }
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
    guide: definition.guide,
  };
}

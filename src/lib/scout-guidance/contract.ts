import { z } from "zod";

export const SCOUT_GUIDANCE_CONTRACT_VERSION = "scout-guidance-v1" as const;

export const scoutGuidanceTrustedSourceSchema = z.enum([
  "capture-session",
  "durable-item-record",
  "price-recommendation",
  "durable-run",
]);

const grandfatheredBcp47Tags = new Map<string, string>([
  ["en-gb-oed", "en-GB-oxendict"],
  ["i-ami", "ami"],
  ["i-bnn", "bnn"],
  ["i-default", "i-default"],
  ["i-enochian", "i-enochian"],
  ["i-hak", "hak"],
  ["i-klingon", "tlh"],
  ["i-lux", "lb"],
  ["i-mingo", "i-mingo"],
  ["i-navajo", "nv"],
  ["i-pwn", "pwn"],
  ["i-tao", "tao"],
  ["i-tay", "tay"],
  ["i-tsu", "tsu"],
  ["sgn-be-fr", "sfb"],
  ["sgn-be-nl", "vgt"],
  ["sgn-ch-de", "sgg"],
  ["art-lojban", "jbo"],
  ["cel-gaulish", "cel-gaulish"],
  ["no-bok", "nb"],
  ["no-nyn", "nn"],
  ["zh-guoyu", "cmn"],
  ["zh-hakka", "hak"],
  ["zh-min", "zh-min"],
  ["zh-min-nan", "nan"],
  ["zh-xiang", "hsn"],
]);

// Derived from the IANA Language Subtag Registry dated 2026-06-15. RFC 5646
// requires every extlang Subtag to equal its Preferred-Value and declares one
// Prefix, so this bounded table records the registered prefix/value pairs.
// https://www.iana.org/assignments/language-subtag-registry
const registeredExtlangSubtagsByPrefix = new Map<string, ReadonlySet<string>>([
  [
    "ar",
    new Set(
      `aao abh abv acm acq acw acx acy adf aeb aec afb ajp apc apd arb
       arq ars ary arz auz avl ayh ayl ayn ayp bbz pga shu ssh`.split(/\s+/),
    ),
  ],
  ["kok", new Set("gom knn".split(" "))],
  ["lv", new Set("ltg lvs".split(" "))],
  [
    "ms",
    new Set(
      `bjn btj bve bvu coa dup hji jak jax kvb kvr kxd lce lcf liw max
       meo mfa mfb min mqg msi mui orn ors pel pse tmw urk vkk vkt xmm
       zlm zmi zsm`.split(/\s+/),
    ),
  ],
  [
    "sgn",
    new Set(
      `ads aed aen afg ajs ase asf asp asq asw bfi bfk bog bqn bqy bvl
       bzs cds csc csd cse csf csg csl csn csq csr csx doq dse dsl dsz
       dyl ecs ehs esl esn eso eth fcs fse fsl fss gds gse gsg gsm gss
       gus hab haf hds hks hos hps hsh hsl icl iks ils inl ins ise isg
       isr jcs jhs jks jls jos jsl jus kgi kvk lbs lgs lls lsb lsc lsg
       lsl lsn lso lsp lst lsv lsw lsy lws mdl mfs mre msd msr mzc mzg
       mzy nbs ncs nsi nsl nsp nsr nzs okl pgz pks prl prz psc psd psg
       psl pso psp psr pys rib rms rnb rsi rsl rsm rsn sdl sfb sfs sgg
       sgx slf sls sqk sqs sqx ssp ssr svk swl syy szs tse tsm tsq tss
       tsy tza ugn ugy ukl uks vgt vsi vsl vsv wbs xki xml xms yds ygs
       yhs ysl ysm zhk zib zsl`.split(/\s+/),
    ),
  ],
  ["sw", new Set("swc swh".split(" "))],
  ["uz", new Set("uzn uzs".split(" "))],
  [
    "zh",
    new Set(
      `cdo cjy cmn cnp cpx csp czh czo gan hak hnm hsn luh lzh mnp nan
       sjc wuu yue`.split(/\s+/),
    ),
  ],
]);

const registeredExtlangPrefixesByPreferredValue = new Map(
  [...registeredExtlangSubtagsByPrefix].flatMap(([prefix, subtags]) =>
    [...subtags].map((subtag) => [subtag, prefix] as const),
  ),
);
const privateUseBcp47Pattern = /^x(?:-[A-Za-z0-9]{1,8})+$/i;

function canonicalizeStructurallyValidBcp47(locale: string): string | null {
  const subtags = locale.split("-");
  const language = subtags[0];
  if (
    !language ||
    !/^[A-Za-z]+$/.test(language) ||
    !(
      (language.length >= 2 && language.length <= 3) ||
      language.length === 4 ||
      (language.length >= 5 && language.length <= 8)
    )
  ) {
    return null;
  }

  const canonical = [language.toLowerCase()];
  let index = 1;
  if (language.length <= 3) {
    let extlangCount = 0;
    while (
      extlangCount < 3 &&
      /^[A-Za-z]{3}$/.test(subtags[index] ?? "")
    ) {
      canonical.push(subtags[index].toLowerCase());
      index += 1;
      extlangCount += 1;
    }
  }

  if (/^[A-Za-z]{4}$/.test(subtags[index] ?? "")) {
    const script = subtags[index].toLowerCase();
    canonical.push(`${script[0].toUpperCase()}${script.slice(1)}`);
    index += 1;
  }
  if (
    /^[A-Za-z]{2}$/.test(subtags[index] ?? "") ||
    /^\d{3}$/.test(subtags[index] ?? "")
  ) {
    canonical.push(subtags[index].toUpperCase());
    index += 1;
  }

  const variants = new Set<string>();
  while (
    /^[A-Za-z0-9]{5,8}$/.test(subtags[index] ?? "") ||
    /^\d[A-Za-z0-9]{3}$/.test(subtags[index] ?? "")
  ) {
    const variant = subtags[index].toLowerCase();
    if (variants.has(variant)) return null;
    variants.add(variant);
    canonical.push(variant);
    index += 1;
  }

  const extensionSingletons = new Set<string>();
  while (/^[0-9A-WY-Za-wy-z]$/.test(subtags[index] ?? "")) {
    const singleton = subtags[index].toLowerCase();
    if (extensionSingletons.has(singleton)) return null;
    extensionSingletons.add(singleton);
    canonical.push(singleton);
    index += 1;
    let extensionLength = 0;
    while (/^[A-Za-z0-9]{2,8}$/.test(subtags[index] ?? "")) {
      canonical.push(subtags[index].toLowerCase());
      index += 1;
      extensionLength += 1;
    }
    if (extensionLength === 0) return null;
  }

  if ((subtags[index] ?? "").toLowerCase() === "x") {
    canonical.push("x");
    index += 1;
    let privateUseLength = 0;
    while (/^[A-Za-z0-9]{1,8}$/.test(subtags[index] ?? "")) {
      canonical.push(subtags[index].toLowerCase());
      index += 1;
      privateUseLength += 1;
    }
    if (privateUseLength === 0) return null;
  }

  return index === subtags.length ? canonical.join("-") : null;
}

function canonicalizeRegisteredExtlang(locale: string): string {
  const [language, extlang, ...suffix] = locale.split("-");
  if (
    extlang &&
    registeredExtlangSubtagsByPrefix.get(language)?.has(extlang)
  ) {
    return [extlang, ...suffix].join("-");
  }
  return locale;
}

function canonicalizeRegisteredExtlangPreferredValue(locale: string): string {
  const [preferredPrimaryLanguage, ...suffix] = locale.split("-");
  const neutralLocale = ["und", ...suffix].join("-");
  try {
    const neutralCanonical = Intl.getCanonicalLocales(neutralLocale)[0];
    return neutralCanonical
      ? [preferredPrimaryLanguage, ...neutralCanonical.split("-").slice(1)].join(
          "-",
        )
      : locale;
  } catch {
    return locale;
  }
}

export function canonicalizeScoutGuidanceLocale(
  locale: string,
): string | null {
  if (privateUseBcp47Pattern.test(locale)) return locale.toLowerCase();
  const grandfathered = grandfatheredBcp47Tags.get(locale.toLowerCase());
  if (grandfathered) return grandfathered;

  const structurallyCanonical = canonicalizeStructurallyValidBcp47(locale);
  if (!structurallyCanonical) return null;
  const extlangCanonical = canonicalizeRegisteredExtlang(structurallyCanonical);
  const preferredPrimaryLanguage = extlangCanonical.split("-", 1)[0];
  if (registeredExtlangPrefixesByPreferredValue.has(preferredPrimaryLanguage)) {
    return canonicalizeRegisteredExtlangPreferredValue(extlangCanonical);
  }
  try {
    return Intl.getCanonicalLocales(extlangCanonical)[0] ?? null;
  } catch {
    return extlangCanonical;
  }
}

const canonicalBcp47LocaleSchema = z
  .string()
  .min(1)
  .refine(
    (locale) => canonicalizeScoutGuidanceLocale(locale) === locale,
    "Locale identifiers must be canonical BCP-47 language tags.",
  );

const substitutionRuleSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
    valueType: z.enum(["integer", "text"]),
    trustedSources: z.array(scoutGuidanceTrustedSourceSchema).min(1),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
    maximumLength: z.number().int().positive().optional(),
    referencePattern: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (
      rule.valueType === "integer" &&
      (rule.minimum === undefined || rule.maximum === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Integer substitutions must declare minimum and maximum bounds.",
      });
    }
    if (
      rule.valueType === "text" &&
      (rule.maximumLength === undefined || rule.referencePattern === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Text substitutions must declare length and provenance bounds.",
      });
    }
    if (
      rule.minimum !== undefined &&
      rule.maximum !== undefined &&
      rule.minimum > rule.maximum
    ) {
      context.addIssue({
        code: "custom",
        message: "Substitution minimum cannot exceed its maximum.",
      });
    }
  });

const pluralCategorySchema = z.enum([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

const pluralCopyKeysSchema = z
  .object({
    selector: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
    body: z.partialRecord(pluralCategorySchema, z.string().min(1)).optional(),
    accessibilityLabel: z
      .partialRecord(pluralCategorySchema, z.string().min(1))
      .optional(),
  })
  .strict()
  .refine(
    (plural) => plural.body !== undefined || plural.accessibilityLabel !== undefined,
    "Plural copy must declare at least one localized message variant.",
  );

export const scoutGuidanceStateSchema = z
  .object({
    family: z.enum([
      "onboarding",
      "capture",
      "processing",
      "uncertainty",
      "recovery",
      "retry",
      "empty",
    ]),
    approvedStateIds: z.array(z.string().min(1)).min(1),
    substitutions: z.array(substitutionRuleSchema),
    copyKeys: z
      .object({
        title: z.string().min(1),
        body: z.string().min(1).nullable(),
        accessibilityLabel: z.string().min(1),
      })
      .strict(),
    pluralCopyKeys: pluralCopyKeysSchema.optional(),
    guide: z
      .object({
        optional: z.literal(true),
        persistent: z.literal(false),
        blocksPrimaryAction: z.literal(false),
        functionalPurpose: z.string().min(1),
        scoutAsset: z
          .string()
          .regex(/^pose-[A-Za-z0-9-]+\.png$/)
          .nullable(),
        motion: z
          .object({
            standard: z.enum(["none", "optional-brief-once"]),
            reducedMotion: z.literal("static"),
            loops: z.literal(false),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (!definition.pluralCopyKeys) return;
    const selector = definition.substitutions.find(
      (substitution) => substitution.key === definition.pluralCopyKeys?.selector,
    );
    if (!selector || selector.valueType !== "integer") {
      context.addIssue({
        code: "custom",
        path: ["pluralCopyKeys", "selector"],
        message: "Plural copy selectors must reference a declared integer substitution.",
      });
    }
    if (definition.copyKeys.body === null && definition.pluralCopyKeys.body) {
      context.addIssue({
        code: "custom",
        path: ["pluralCopyKeys", "body"],
        message: "Plural body copy requires a base body copy key.",
      });
    }
  });

function parseTemplate(template: string): {
  variables: string[];
  malformedBraces: boolean;
} {
  const variables = Array.from(
    template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g),
    (match) => match[1],
  );
  return {
    variables,
    malformedBraces: /[{}]/.test(
      template.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""),
    ),
  };
}

function sameVariables(actual: string[], expected: string[]): boolean {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return (
    actualSet.size === expectedSet.size &&
    [...actualSet].every((variable) => expectedSet.has(variable))
  );
}

export const scoutGuidanceCatalogSchema = z
  .object({
    contractVersion: z.literal(SCOUT_GUIDANCE_CONTRACT_VERSION),
    defaultLocale: canonicalBcp47LocaleSchema,
    accessibilityPolicy: z
      .object({
        scoutAssetDecorative: z.literal(true),
        meaningCompleteInText: z.literal(true),
        statusNeverColorOnly: z.literal(true),
      })
      .strict(),
    states: z.record(z.string().min(1), scoutGuidanceStateSchema),
    locales: z.record(
      canonicalBcp47LocaleSchema,
      z.record(z.string().min(1), z.string().min(1)),
    ),
  })
  .strict()
  .superRefine((catalog, context) => {
    const defaultCopy = catalog.locales[catalog.defaultLocale];
    if (!defaultCopy) {
      context.addIssue({
        code: "custom",
        path: ["defaultLocale"],
        message: "The default locale must exist in the locale catalog.",
      });
      return;
    }

    for (const [state, definition] of Object.entries(catalog.states)) {
      const allowedVariables = new Set(
        definition.substitutions.map((substitution) => substitution.key),
      );
      const usedVariables = new Set<string>();
      const copyKeys = [
        definition.copyKeys.title,
        ...(definition.copyKeys.body ? [definition.copyKeys.body] : []),
        definition.copyKeys.accessibilityLabel,
        ...Object.values(definition.pluralCopyKeys?.body ?? {}),
        ...Object.values(
          definition.pluralCopyKeys?.accessibilityLabel ?? {},
        ),
      ];

      for (const copyKey of copyKeys) {
        const template = defaultCopy[copyKey];
        if (!template) {
          context.addIssue({
            code: "custom",
            path: ["states", state, "copyKeys"],
            message: `Default locale is missing copy key ${copyKey}.`,
          });
          continue;
        }
        const defaultTemplate = parseTemplate(template);
        if (defaultTemplate.malformedBraces) {
          context.addIssue({
            code: "custom",
            path: ["locales", catalog.defaultLocale, copyKey],
            message: `Locale ${catalog.defaultLocale} copy key ${copyKey} contains malformed template braces.`,
          });
        }
        for (const variable of defaultTemplate.variables) {
          usedVariables.add(variable);
          if (!allowedVariables.has(variable)) {
            context.addIssue({
              code: "custom",
              path: ["locales", catalog.defaultLocale, copyKey],
              message: `Template variable ${variable} is not approved for ${state}.`,
            });
          }
        }

        for (const [locale, localizedCopy] of Object.entries(catalog.locales)) {
          const localizedTemplate = localizedCopy[copyKey];
          if (!localizedTemplate) {
            context.addIssue({
              code: "custom",
              path: ["locales", locale],
              message: `Locale ${locale} is missing copy key ${copyKey}.`,
            });
            continue;
          }
          const parsedTemplate = parseTemplate(localizedTemplate);
          if (parsedTemplate.malformedBraces) {
            context.addIssue({
              code: "custom",
              path: ["locales", locale, copyKey],
              message: `Locale ${locale} copy key ${copyKey} contains malformed template braces.`,
            });
            continue;
          }
          if (
            !sameVariables(
              parsedTemplate.variables,
              defaultTemplate.variables,
            )
          ) {
            const expectedVariables =
              [...new Set(defaultTemplate.variables)].join(", ") || "(none)";
            context.addIssue({
              code: "custom",
              path: ["locales", locale, copyKey],
              message: `Locale ${locale} template ${copyKey} must use exactly approved variables: ${expectedVariables}.`,
            });
          }
        }
      }
      for (const variable of allowedVariables) {
        if (!usedVariables.has(variable)) {
          context.addIssue({
            code: "custom",
            path: ["states", state, "substitutions"],
            message: `Approved substitution ${variable} is unused by ${state}.`,
          });
        }
      }
    }
  });

export type ScoutGuidanceCatalog = z.infer<typeof scoutGuidanceCatalogSchema>;
export type ScoutGuidanceDefinition = z.infer<typeof scoutGuidanceStateSchema>;
export type ScoutGuidanceTrustedSource = z.infer<
  typeof scoutGuidanceTrustedSourceSchema
>;

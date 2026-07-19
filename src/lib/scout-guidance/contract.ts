import { z } from "zod";

export const SCOUT_GUIDANCE_CONTRACT_VERSION = "scout-guidance-v1" as const;

export const scoutGuidanceTrustedSourceSchema = z.enum([
  "capture-session",
  "durable-item-record",
  "price-recommendation",
  "durable-run",
  "seller-confirmed-item",
]);

export function canonicalizeScoutGuidanceLocale(
  locale: string,
): string | null {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
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

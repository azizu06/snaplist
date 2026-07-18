import { z } from "zod";

export const SCOUT_GUIDANCE_CONTRACT_VERSION = "scout-guidance-v1" as const;

export const scoutGuidanceTrustedSourceSchema = z.enum([
  "capture-session",
  "durable-item-record",
  "price-recommendation",
  "durable-run",
  "seller-confirmed-item",
]);

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
  .strict();

const templateVariables = (template: string): string[] =>
  Array.from(template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g), (match) => match[1]);

export const scoutGuidanceCatalogSchema = z
  .object({
    contractVersion: z.literal(SCOUT_GUIDANCE_CONTRACT_VERSION),
    defaultLocale: z.string().min(1),
    accessibilityPolicy: z
      .object({
        scoutAssetDecorative: z.literal(true),
        meaningCompleteInText: z.literal(true),
        statusNeverColorOnly: z.literal(true),
      })
      .strict(),
    states: z.record(z.string().min(1), scoutGuidanceStateSchema),
    locales: z.record(z.string().min(1), z.record(z.string().min(1), z.string().min(1))),
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
      ];

      for (const [locale, localizedCopy] of Object.entries(catalog.locales)) {
        for (const copyKey of copyKeys) {
          if (!localizedCopy[copyKey]) {
            context.addIssue({
              code: "custom",
              path: ["locales", locale],
              message: `Locale ${locale} is missing copy key ${copyKey}.`,
            });
          }
        }
      }

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
        for (const variable of templateVariables(template)) {
          usedVariables.add(variable);
          if (!allowedVariables.has(variable)) {
            context.addIssue({
              code: "custom",
              path: ["locales", catalog.defaultLocale, copyKey],
              message: `Template variable ${variable} is not approved for ${state}.`,
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

import { z } from "zod";

/**
 * Facebook Marketplace + Mercari export-pack constraints (issue #15).
 *
 * These are the platform contracts the generated packs must satisfy BEFORE they
 * are mapped onto the generic `ListingCopy` seam (`pipeline/types`) — the same
 * structure-over-prompt stance as the eBay contract in `listing/schema.ts`
 * (PRD: "per-platform output validated against platform constraints … no
 * attributes hallucinated beyond the validated core"):
 *
 *  FACEBOOK MARKETPLACE (casual, local, short):
 *   - TITLE: required, ≤ 99 characters (Marketplace's title cap).
 *   - DESCRIPTION: required, kept SHORT (≤ 600 chars — our product constraint;
 *     Marketplace allows far more, but the FB convention the issue encodes is a
 *     casual couple-of-sentences blurb, so the cap is enforced structurally).
 *
 *  MERCARI (short title, hashtags, shipping-oriented):
 *   - TITLE: required, ≤ 40 characters (Mercari's hard title cap).
 *   - DESCRIPTION: required, ≤ 1000 characters (Mercari's description cap).
 *   - HASHTAGS: 0–3 normalized `#lowercasealphanumeric` tags (Mercari's seller
 *     guidance: a few targeted hashtags in the description). Bounded and
 *     format-validated by the schema, and — crucially — reconciled in
 *     `generate.ts` against a whitelist DERIVED FROM THE VALIDATED CORE, so a
 *     hashtag can never smuggle in an attribute the core never established.
 *
 * Over-long titles/descriptions are repaired DETERMINISTICALLY (word-boundary
 * truncation, reusing the eBay repair) before validation, so the returned packs
 * always satisfy the caps regardless of what the model emitted.
 */

/** Platform discriminators stamped onto the resulting `ListingCopy` rows. */
export const FACEBOOK_PLATFORM = "facebook" as const;
export const MERCARI_PLATFORM = "mercari" as const;

/** Facebook Marketplace's title cap, in characters. */
export const FACEBOOK_TITLE_MAX_LENGTH = 99;

/**
 * Our structural "short and casual" cap for the FB description. Marketplace
 * itself allows thousands of characters; the convention this slice encodes is a
 * brief local-sale blurb, so shortness is a schema rule, not a prompt hope.
 */
export const FACEBOOK_DESCRIPTION_MAX_LENGTH = 600;

/** Mercari's hard title cap, in characters. */
export const MERCARI_TITLE_MAX_LENGTH = 40;

/** Mercari's description cap, in characters. */
export const MERCARI_DESCRIPTION_MAX_LENGTH = 1000;

/** Maximum hashtags in a Mercari pack (a few targeted tags, not spam). */
export const MERCARI_MAX_HASHTAGS = 3;

/** Platform discriminator for the Depop assisted-export pack (issue #378). */
export const DEPOP_PLATFORM = "depop" as const;

/**
 * Depop's description cap, in characters. Depop has NO separate title field —
 * the description IS the listing text — so a Depop pack carries no title, and
 * `buildDepopDescription` puts the item's identity in the opening words
 * because Depop's search weights the start of the description most heavily.
 */
export const DEPOP_DESCRIPTION_MAX_LENGTH = 1000;

/** Depop's hashtag cap. */
export const DEPOP_MAX_HASHTAGS = 5;

/** A normalized Mercari hashtag: `#` + lowercase alphanumerics, nothing else. */
export const mercariHashtagSchema = z
  .string()
  .regex(
    /^#[a-z0-9]+$/,
    "Mercari hashtags must be '#' followed by lowercase letters/digits only",
  );

/** The validated Facebook Marketplace export pack. */
export const facebookPackSchema = z.object({
  /** Casual, friendly title. Required, ≤ 99 chars (the Marketplace cap). */
  title: z
    .string()
    .min(1, "Facebook title is required")
    .max(
      FACEBOOK_TITLE_MAX_LENGTH,
      `Facebook title must be ${FACEBOOK_TITLE_MAX_LENGTH} characters or fewer`,
    ),
  /** Short, casual, local-sale description. Required, structurally short. */
  description: z
    .string()
    .min(1, "Facebook description is required")
    .max(
      FACEBOOK_DESCRIPTION_MAX_LENGTH,
      `Facebook description must stay short (≤ ${FACEBOOK_DESCRIPTION_MAX_LENGTH} characters)`,
    ),
});

export type FacebookPack = z.infer<typeof facebookPackSchema>;

/** The validated Mercari export pack. */
export const mercariPackSchema = z.object({
  /** Keyword-first short title. Required, ≤ 40 chars (Mercari's hard cap). */
  title: z
    .string()
    .min(1, "Mercari title is required")
    .max(
      MERCARI_TITLE_MAX_LENGTH,
      `Mercari title must be ${MERCARI_TITLE_MAX_LENGTH} characters or fewer`,
    ),
  /** Shipping-oriented description. Required, ≤ 1000 chars. */
  description: z
    .string()
    .min(1, "Mercari description is required")
    .max(
      MERCARI_DESCRIPTION_MAX_LENGTH,
      `Mercari description must be ${MERCARI_DESCRIPTION_MAX_LENGTH} characters or fewer`,
    ),
  /** 0–3 normalized hashtags, each reconciled against the validated core. */
  hashtags: z
    .array(mercariHashtagSchema)
    .max(
      MERCARI_MAX_HASHTAGS,
      `At most ${MERCARI_MAX_HASHTAGS} Mercari hashtags`,
    ),
});

export type MercariPack = z.infer<typeof mercariPackSchema>;

/**
 * The validated Depop export pack. Unlike Facebook and Mercari it has NO
 * title: Depop's listing form has no title field, so inventing one would
 * describe a field the seller cannot fill. Both fields are assembled
 * deterministically from the validated core in `generate.ts`, so this pack has
 * no model free-text channel at all.
 */
export const depopPackSchema = z.object({
  /** Keyword-first, core-built description. Required, ≤ 1000 chars. */
  description: z
    .string()
    .min(1, "Depop description is required")
    .max(
      DEPOP_DESCRIPTION_MAX_LENGTH,
      `Depop description must be ${DEPOP_DESCRIPTION_MAX_LENGTH} characters or fewer`,
    ),
  /** 0–5 normalized hashtags, each derived from the validated core. */
  hashtags: z
    .array(mercariHashtagSchema)
    .max(DEPOP_MAX_HASHTAGS, `At most ${DEPOP_MAX_HASHTAGS} Depop hashtags`),
});

export type DepopPack = z.infer<typeof depopPackSchema>;

/**
 * PERMISSIVE schema handed to `generateObject` on the real path (mirrors
 * `ebayListingRawSchema`): it relaxes exactly the DETERMINISTICALLY-REPAIRABLE
 * constraints — title length caps and the hashtag format/count — so the
 * model's output is ACCEPTED by the SDK and reaches the repair/whitelist step
 * instead of throwing inside `generateObject`. The repaired packs are then
 * validated against the strict schemas above.
 *
 * DESCRIPTIONS are deliberately IGNORED: the published descriptions are
 * assembled deterministically from the validated core in `generate.ts` (an
 * invented digit-free claim like "Includes charger" cannot be detected
 * deterministically in model free text, so model-authored description copy is
 * never published). The fields remain accepted here only so a model that emits
 * one anyway does not fail schema validation.
 *
 * They are NULLABLE, never `.optional()` (issue #696). OpenAI structured
 * outputs in strict mode reject a compiled schema in which any key of
 * `properties` is absent from `required` — an `.optional()` field 400s the
 * request outright with `'description' is required to be supplied and to be
 * not null`, killing every production run that reaches export-pack generation.
 * So the KEY is always required and "I have no description" is expressed in the
 * VALUE as `null`. Nothing reads it either way: `reconcilePacks` builds every
 * published description from the core, so `null` reaches exactly the same
 * deterministic assembly that model-authored text does.
 */
export const rawExportPacksSchema = z.object({
  facebook: z.object({
    title: z.string().min(1, "Facebook title is required"),
    /** Accepted but IGNORED — published FB descriptions are core-built. `null` = none. */
    description: z.string().nullable(),
  }),
  mercari: z.object({
    title: z.string().min(1, "Mercari title is required"),
    /** Accepted but IGNORED — published Mercari descriptions are core-built. `null` = none. */
    description: z.string().nullable(),
    hashtags: z.array(z.string()),
  }),
});

export type RawExportPacks = z.infer<typeof rawExportPacksSchema>;

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedAttributes } from "../pipeline/types";
import {
  generateExportPacks,
  type ExportPackGenerate,
} from "./generate";
import {
  FACEBOOK_PLATFORM,
  MERCARI_PLATFORM,
  facebookPackSchema,
  mercariPackSchema,
} from "./schema";

/**
 * Load-or-generate seam for the export page (issue #15): the packs are
 * generated ONCE per item and persisted as `listings` rows (platform
 * 'facebook' / 'mercari' — exactly the platforms the schema migration
 * anticipated), then served from those rows on every later visit. All reads
 * and writes go through the caller's USER-SCOPED Supabase client so RLS
 * enforces tenancy (AGENTS.md non-negotiable #1), matching
 * `pipeline/persist.ts`.
 *
 * The model call stays injectable through `generate`, so this helper is
 * offline-testable with a fake client + fake generate.
 */

/** What the export surface renders for one platform. */
export interface ExportPackView {
  title: string;
  description: string;
  /** The single paste-ready block. */
  copyBlock: string;
  /** Mercari only; empty for Facebook. */
  hashtags: string[];
}

export interface ExportPacksView {
  facebook: ExportPackView;
  mercari: ExportPackView;
  /** True when both packs were served from persisted rows (no model call). */
  cached: boolean;
  /** The generating model id; undefined when served from cache. */
  model?: string;
}

export interface LoadOrGeneratePacksInput {
  /** The owning user's id (must equal the client's auth.uid()). */
  userId: string;
  itemId: string;
  /** The item's validated attribute core (from the `items` row). */
  attributes: ExtractedAttributes;
  /** The item's stored price (whatever the item record carries), if any. */
  price?: number;
  /** Injected model call, forwarded to `generateExportPacks`. */
  generate?: ExportPackGenerate;
  /** Model id override, forwarded to `generateExportPacks`. */
  model?: string;
}

interface ListingRow {
  platform: string;
  title: string | null;
  description: string | null;
  copy: Record<string, unknown> | null;
}

/**
 * Parse a persisted listings row back into a renderable pack view. Returns null
 * unless the row round-trips its strict platform schema AND carries the stored
 * copy block — a stale/foreign row falls through to regeneration instead of
 * rendering something invalid.
 */
function rowToView(row: ListingRow): ExportPackView | null {
  const copyBlock = row.copy?.["copyBlock"];
  if (typeof copyBlock !== "string" || copyBlock.length === 0) return null;
  if (row.platform === FACEBOOK_PLATFORM) {
    const parsed = facebookPackSchema.safeParse({
      title: row.title,
      description: row.description,
    });
    if (!parsed.success) return null;
    return { ...parsed.data, copyBlock, hashtags: [] };
  }
  if (row.platform === MERCARI_PLATFORM) {
    const parsed = mercariPackSchema.safeParse({
      title: row.title,
      description: row.description,
      hashtags: row.copy?.["hashtags"] ?? [],
    });
    if (!parsed.success) return null;
    return { ...parsed.data, copyBlock };
  }
  return null;
}

/**
 * Serve both packs for an item: from the persisted `listings` rows when both
 * platforms already have a valid pack, otherwise generate, persist the missing
 * platform rows (status 'draft', user-pinned for RLS WITH CHECK), and return
 * the fresh result.
 */
export async function loadOrGenerateExportPacks(
  supabase: SupabaseClient,
  input: LoadOrGeneratePacksInput,
): Promise<ExportPacksView> {
  // Newest-first so the first valid row per platform is the latest one.
  const { data: rows, error: readErr } = await supabase
    .from("listings")
    .select("platform, title, description, copy")
    .eq("item_id", input.itemId)
    .in("platform", [FACEBOOK_PLATFORM, MERCARI_PLATFORM])
    .order("created_at", { ascending: false });
  if (readErr) {
    throw new Error(`Failed to read export packs: ${readErr.message}`);
  }

  let storedFacebook: ExportPackView | null = null;
  let storedMercari: ExportPackView | null = null;
  for (const row of (rows ?? []) as ListingRow[]) {
    if (row.platform === FACEBOOK_PLATFORM && !storedFacebook) {
      storedFacebook = rowToView(row);
    } else if (row.platform === MERCARI_PLATFORM && !storedMercari) {
      storedMercari = rowToView(row);
    }
  }

  if (storedFacebook && storedMercari) {
    return { facebook: storedFacebook, mercari: storedMercari, cached: true };
  }

  const result = await generateExportPacks({
    attributes: input.attributes,
    price: input.price,
    generate: input.generate,
    model: input.model,
  });

  // Persist only the platforms that lack a valid stored pack, so a partial
  // earlier write never produces duplicate rows for the platform it covered.
  const inserts = [
    ...(storedFacebook
      ? []
      : [
          {
            user_id: input.userId,
            item_id: input.itemId,
            platform: FACEBOOK_PLATFORM,
            title: result.facebook.pack.title,
            description: result.facebook.pack.description,
            copy: result.facebook.copy.fields,
            status: "draft",
          },
        ]),
    ...(storedMercari
      ? []
      : [
          {
            user_id: input.userId,
            item_id: input.itemId,
            platform: MERCARI_PLATFORM,
            title: result.mercari.pack.title,
            description: result.mercari.pack.description,
            copy: result.mercari.copy.fields,
            status: "draft",
          },
        ]),
  ];
  if (inserts.length > 0) {
    const { error: insertErr } = await supabase.from("listings").insert(inserts);
    if (insertErr) {
      throw new Error(`Failed to persist export packs: ${insertErr.message}`);
    }
  }

  return {
    facebook:
      storedFacebook ?? {
        ...result.facebook.pack,
        copyBlock: result.facebook.copyBlock,
        hashtags: [],
      },
    mercari:
      storedMercari ?? {
        ...result.mercari.pack,
        copyBlock: result.mercari.copyBlock,
      },
    cached: false,
    model: result.model,
  };
}

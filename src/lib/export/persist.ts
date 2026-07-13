import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedAttributes } from "../pipeline/types";
import {
  facebookCopyBlock,
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
  /**
   * The generating model id — provenance is PERSISTED with each pack row
   * (copy.model) so export outputs stay attributable in the eval harness, and
   * cached reads return the stored id. Undefined only for legacy rows written
   * before provenance landed.
   */
  model?: string;
}

export interface LoadOrGeneratePacksInput {
  /** The owning user's id (must equal the client's auth.uid()). */
  userId: string;
  itemId: string;
  reviewRevision: string;
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
 *
 * FACEBOOK PRICE FRESHNESS: the FB block's meta lines (condition / "Asking $X" /
 * pickup) are deterministic renderings, never model text — so the FB copy block
 * is REBUILT on every read from the persisted title + description plus the
 * CURRENT price and condition, instead of echoing the persisted snapshot. A new
 * pricing run therefore can never serve a stale "Asking" line, while the
 * load-or-generate semantics stay intact (no model call; the persisted
 * `copy.copyBlock` remains a generation-time snapshot used only as a validity
 * marker that this row was written by the export feature).
 */
function rowToView(
  row: ListingRow,
  current: { price?: number; condition?: string },
): ExportPackView | null {
  const copyBlock = row.copy?.["copyBlock"];
  if (typeof copyBlock !== "string" || copyBlock.length === 0) return null;
  if (row.platform === FACEBOOK_PLATFORM) {
    const parsed = facebookPackSchema.safeParse({
      title: row.title,
      description: row.description,
    });
    if (!parsed.success) return null;
    return {
      ...parsed.data,
      copyBlock: facebookCopyBlock(parsed.data, current),
      hashtags: [],
    };
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
    .eq("source_review_revision", input.reviewRevision)
    .in("platform", [FACEBOOK_PLATFORM, MERCARI_PLATFORM])
    .order("created_at", { ascending: false });
  if (readErr) {
    throw new Error(`Failed to read export packs: ${readErr.message}`);
  }

  const current = {
    price: input.price,
    condition: input.attributes.condition,
  };
  let storedFacebook: ExportPackView | null = null;
  let storedMercari: ExportPackView | null = null;
  let storedModel: string | undefined;
  for (const row of (rows ?? []) as ListingRow[]) {
    if (row.platform === FACEBOOK_PLATFORM && !storedFacebook) {
      storedFacebook = rowToView(row, current);
    } else if (row.platform === MERCARI_PLATFORM && !storedMercari) {
      storedMercari = rowToView(row, current);
    } else {
      continue;
    }
    // Provenance rides with whichever stored row served a pack (rows from one
    // generation share the same model id).
    const model = row.copy?.["model"];
    if (storedModel === undefined && typeof model === "string" && model !== "") {
      storedModel = model;
    }
  }

  if (storedFacebook && storedMercari) {
    return {
      facebook: storedFacebook,
      mercari: storedMercari,
      cached: true,
      model: storedModel,
    };
  }

  const result = await generateExportPacks({
    attributes: input.attributes,
    price: input.price,
    generate: input.generate,
    model: input.model,
  });

  // Persist only the platforms that lack a valid stored pack, so a partial
  // earlier write never produces duplicate rows for the platform it covered.
  // Each row carries its generating model id (copy.model) — export outputs
  // must stay attributable (AGENTS.md: log every run's model), including on
  // later cached reads.
  const inserts = [
    ...(storedFacebook
      ? []
      : [
          {
            platform: FACEBOOK_PLATFORM,
            title: result.facebook.pack.title,
            description: result.facebook.pack.description,
            copy: { ...result.facebook.copy.fields, model: result.model },
          },
        ]),
    ...(storedMercari
      ? []
      : [
          {
            platform: MERCARI_PLATFORM,
            title: result.mercari.pack.title,
            description: result.mercari.pack.description,
            copy: { ...result.mercari.copy.fields, model: result.model },
          },
        ]),
  ];
  if (inserts.length > 0) {
    const { error: insertErr } = await supabase.rpc("persist_export_packs", {
      p_item_id: input.itemId,
      p_source_review_revision: input.reviewRevision,
      p_packs: inserts,
    });
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

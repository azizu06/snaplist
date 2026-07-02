import type { SupabaseClient } from "@supabase/supabase-js";
import { effectivePrice } from "../pipeline";
import { itemLabel } from "../ui/item-label";
import { sentenceCase } from "../ui/format";
import { signPhotoUrlMap } from "../vision/photos";

/**
 * Dashboard intake rows — the "one row per Item" invariant, extracted from
 * `dashboard/page.tsx` (where it lived inline, untested, through the post-#52
 * production outage): the NEWEST eBay listing represents its item; unlisted items
 * still appear (status `new` → "Processing") so nothing the seller uploaded
 * disappears; the latest logged price is shown with the seller override winning.
 *
 * `assembleDashboardRows` is the PURE core (the unit-test target); `loadDashboardRows`
 * is the thin RLS-scoped I/O wrapper the page calls.
 */

/** The `listings` columns the dashboard reads (query is newest-first). */
export interface DashboardListingSource {
  id: unknown;
  item_id: unknown;
  title: unknown;
  status: unknown;
  created_at: unknown;
}

/** The `items` columns the dashboard reads (query is newest-first). */
export interface DashboardItemSource {
  id: unknown;
  attributes: unknown;
  photos: unknown;
  price_override: unknown;
  created_at: unknown;
}

/** One dashboard table row. Shape-compatible with the view's `DashboardRow`. */
export interface DashboardRowData {
  itemId: string;
  listingId: string | null;
  title: string;
  status: string;
  createdAt: string;
  price: number | null;
  thumbUrl: string | null;
  category: string | null;
  condition: string | null;
}

/** Read a trimmed string attribute off an item's JSON `attributes`. */
function attrString(attrs: unknown, key: string): string | null {
  if (attrs && typeof attrs === "object" && key in attrs) {
    const v = (attrs as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Latest logged price per item from prediction-log rows. Expects NEWEST-FIRST
 * input (the query's ordering): the first priced row per item wins; null prices
 * are skipped so an unpriced retry never masks the real latest price.
 */
export function latestPricePerItem(
  logs: Array<{ item_id: unknown; price: unknown }> | null | undefined,
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const log of logs ?? []) {
    const itemId = log.item_id as string;
    if (!latest.has(itemId) && log.price != null) {
      latest.set(itemId, Number(log.price));
    }
  }
  return latest;
}

export interface AssembleDashboardRowsInput {
  /** eBay listings, NEWEST-FIRST (the first listing seen per item wins). */
  listings: DashboardListingSource[] | null | undefined;
  /** The seller's items, newest-first. */
  items: DashboardItemSource[] | null | undefined;
  /** Latest logged price per item (see `latestPricePerItem`). */
  latestPrice: Map<string, number>;
  /** Resolve an item's signed thumbnail URL (null = placeholder). Injected so the pure core never touches storage. */
  thumbUrlFor: (itemId: string) => string | null;
}

/**
 * PURE row assembly: one row per item — newest eBay listing wins; unlisted items
 * appended as status `new`; rows sorted newest-first across both branches.
 * Row titles use the SHORT item label (brand + model via `itemLabel`), NOT the
 * keyword-stuffed eBay SEO title; the listing title is only a fallback when the
 * item row is missing/unlabeled. The seller's price override beats the latest
 * suggested price (`effectivePrice`); an override with no logged price still shows.
 */
export function assembleDashboardRows(
  input: AssembleDashboardRowsInput,
): DashboardRowData[] {
  const { listings, items, latestPrice, thumbUrlFor } = input;

  const itemsById = new Map(
    (items ?? []).map((item) => [item.id as string, item] as const),
  );

  const rowPrice = (itemId: string): number | null => {
    const item = itemsById.get(itemId);
    const override =
      item?.price_override != null ? Number(item.price_override) : null;
    const suggested = latestPrice.get(itemId) ?? null;
    return suggested != null ? effectivePrice(suggested, override) : override;
  };

  // One row per item: newest eBay listing wins (input is newest-first).
  const newestPerItem = new Map<string, DashboardListingSource>();
  for (const l of listings ?? []) {
    if (!newestPerItem.has(l.item_id as string)) {
      newestPerItem.set(l.item_id as string, l);
    }
  }

  return [
    ...[...newestPerItem.values()].map((l) => {
      const item = itemsById.get(l.item_id as string);
      return {
        itemId: l.item_id as string,
        listingId: l.id as string,
        title: item
          ? itemLabel(item.attributes, item.id as string)
          : ((l.title as string | null) ?? "Untitled"),
        status: (l.status as string | null) ?? "new",
        createdAt: (l.created_at as string | null) ?? "",
        price: rowPrice(l.item_id as string),
        thumbUrl: thumbUrlFor(l.item_id as string),
        category: item ? sentenceCase(attrString(item.attributes, "category")) : null,
        condition: item ? sentenceCase(attrString(item.attributes, "condition")) : null,
      };
    }),
    ...(items ?? [])
      .filter((item) => !newestPerItem.has(item.id as string))
      .map((item) => ({
        itemId: item.id as string,
        listingId: null,
        title: itemLabel(item.attributes, item.id as string),
        status: "new",
        createdAt: (item.created_at as string | null) ?? "",
        price: rowPrice(item.id as string),
        thumbUrl: thumbUrlFor(item.id as string),
        category: sentenceCase(attrString(item.attributes, "category")),
        condition: sentenceCase(attrString(item.attributes, "condition")),
      })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Load the seller's dashboard rows: three RLS-scoped reads (newest-first, same
 * limits as before the extraction) + batch-signed first-photo thumbnails, fed
 * into the pure `assembleDashboardRows`.
 */
export async function loadDashboardRows(
  supabase: SupabaseClient,
): Promise<DashboardRowData[]> {
  const [{ data: listings }, { data: items }, { data: logs }] = await Promise.all([
    supabase
      .from("listings")
      .select("id, item_id, title, status, created_at")
      .eq("platform", "ebay")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("items")
      .select("id, attributes, photos, price_override, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("prediction_logs")
      .select("item_id, price, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  // Batch-sign first photos (private bucket) for the table thumbnails.
  const firstPhotoByItem = new Map<string, string>();
  for (const item of items ?? []) {
    const first = (item.photos as string[] | null)?.[0];
    if (first) firstPhotoByItem.set(item.id as string, first);
  }
  const signedByPath = await signPhotoUrlMap(supabase, [
    ...firstPhotoByItem.values(),
  ]);

  return assembleDashboardRows({
    listings,
    items,
    latestPrice: latestPricePerItem(logs),
    thumbUrlFor: (itemId) => {
      const path = firstPhotoByItem.get(itemId);
      return path ? (signedByPath.get(path) ?? null) : null;
    },
  });
}

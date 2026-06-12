import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { effectivePrice } from "@/lib/pipeline";
import {
  DashboardView,
  DASHBOARD_FILTERS,
  type DashboardRow,
} from "./dashboard-view";

/**
 * /dashboard — the seller dashboard (issue #49: the marketing landing now
 * owns `/`; the app lives here). This file is data assembly only: RLS-scoped
 * reads, newest-eBay-listing-per-item union with unlisted items, signed
 * thumbnail URLs, latest logged price per item with the seller override
 * winning. The auth proxy gates the route; the redirect below is
 * defense-in-depth.
 */
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: rawFilter } = await searchParams;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/dashboard");

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

  const itemLabel = (attributes: unknown, id: string): string => {
    const parsed = extractedAttributesSchema.safeParse(attributes ?? {});
    if (parsed.success) {
      const a = parsed.data;
      const label = [a.brand, a.model].filter(Boolean).join(" ") || a.title;
      if (label) return label;
    }
    return `Item ${id.slice(0, 8)}`;
  };

  // Latest logged price per item (rows already newest-first).
  const latestPrice = new Map<string, number>();
  for (const log of logs ?? []) {
    const itemId = log.item_id as string;
    if (!latestPrice.has(itemId) && log.price != null) {
      latestPrice.set(itemId, Number(log.price));
    }
  }

  // Batch-sign first photos (private bucket) for the table thumbnails.
  const itemsById = new Map(
    (items ?? []).map((item) => [item.id as string, item] as const),
  );
  const firstPhotoByItem = new Map<string, string>();
  for (const item of items ?? []) {
    const first = (item.photos as string[] | null)?.[0];
    if (first) firstPhotoByItem.set(item.id as string, first);
  }
  const signedByPath = new Map<string, string>();
  if (firstPhotoByItem.size > 0) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrls([...firstPhotoByItem.values()], 60 * 10);
    for (const entry of signed ?? []) {
      if (entry.signedUrl && entry.path) {
        signedByPath.set(entry.path, entry.signedUrl);
      }
    }
  }

  const rowPrice = (itemId: string): number | null => {
    const item = itemsById.get(itemId);
    const override =
      item?.price_override != null ? Number(item.price_override) : null;
    const suggested = latestPrice.get(itemId) ?? null;
    return suggested != null ? effectivePrice(suggested, override) : override;
  };
  const rowThumb = (itemId: string): string | null => {
    const path = firstPhotoByItem.get(itemId);
    return path ? (signedByPath.get(path) ?? null) : null;
  };

  // One row per item: newest eBay listing wins; unlisted items show as
  // Processing so nothing the seller uploaded disappears.
  const newestPerItem = new Map<string, NonNullable<typeof listings>[number]>();
  for (const l of listings ?? []) {
    if (!newestPerItem.has(l.item_id as string)) {
      newestPerItem.set(l.item_id as string, l);
    }
  }

  const rows: DashboardRow[] = [
    ...[...newestPerItem.values()].map((l) => {
      const item = itemsById.get(l.item_id as string);
      return {
        itemId: l.item_id as string,
        listingId: l.id as string,
        title:
          (l.title as string | null) ??
          (item ? itemLabel(item.attributes, item.id as string) : "Untitled"),
        status: (l.status as string | null) ?? "new",
        createdAt: (l.created_at as string | null) ?? "",
        price: rowPrice(l.item_id as string),
        thumbUrl: rowThumb(l.item_id as string),
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
        thumbUrl: rowThumb(item.id as string),
      })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const counts = {
    draft: rows.filter((r) => r.status === "draft").length,
    attention: rows.filter(
      (r) => r.status === "failed" || r.status === "draft_failed",
    ).length,
    live: rows.filter((r) => r.status === "published").length,
  };

  const filter = DASHBOARD_FILTERS.some((f) => f.key === rawFilter)
    ? (rawFilter as (typeof DASHBOARD_FILTERS)[number]["key"])
    : "all";

  return <DashboardView rows={rows} counts={counts} filter={filter} />;
}

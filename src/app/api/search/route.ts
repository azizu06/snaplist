import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { firstSearchToken, searchRows } from "@/lib/ui/search";
import { itemLabel } from "@/lib/ui/item-label";

/**
 * GET /api/search?q=… — the ⌘K palette's data source. RLS-scoped (the
 * Supabase server client carries the Clerk session), so a user can only ever
 * search their own inventory. Matching/ranking lives in the pure, tested
 * searchRows; this route only assembles candidates: one entry per item,
 * newest eBay listing's title/status winning over the raw item attributes.
 */

export interface SearchHit {
  itemId: string;
  title: string;
  status: string;
  /** Signed first-photo URL (≤10 min) so the palette row shows the same
   *  thumbnail as the dashboard list. Null when the item has no photo. */
  thumbUrl: string | null;
}

export async function GET(request: Request) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const supabase = await createClient();

  // Push the first query token into Postgres so matches aren't limited to
  // the newest rows (Codex P2 on PR #52): a seller with years of inventory
  // can still find old items, and pipeline reruns inserting duplicate
  // listing rows for one item can't crowd matching rows out of the window.
  // The full multi-token matcher/ranker still runs in-process below.
  const tok = firstSearchToken(q);
  let listingsQuery = supabase
    .from("listings")
    .select("id, item_id, title, status, created_at")
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(200);
  let itemsQuery = supabase
    .from("items")
    .select("id, attributes, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (tok) {
    listingsQuery = listingsQuery.ilike("title", `%${tok}%`);
    itemsQuery = itemsQuery.or(
      `attributes->>title.ilike.*${tok}*,attributes->>brand.ilike.*${tok}*,attributes->>model.ilike.*${tok}*`,
    );
  }
  const [{ data: listings }, { data: items }] = await Promise.all([
    listingsQuery,
    itemsQuery,
  ]);

  const newestPerItem = new Map<string, NonNullable<typeof listings>[number]>();
  for (const l of listings ?? []) {
    const itemId = l.item_id as string;
    if (!newestPerItem.has(itemId)) newestPerItem.set(itemId, l);
  }

  const candidates = [
    ...[...newestPerItem.values()].map((l) => ({
      itemId: l.item_id as string,
      title: (l.title as string | null) ?? "Untitled",
      status: (l.status as string | null) ?? "new",
      createdAt: (l.created_at as string | null) ?? "",
    })),
    ...(items ?? [])
      .filter((item) => !newestPerItem.has(item.id as string))
      .map((item) => ({
        itemId: item.id as string,
        title: itemLabel(item.attributes, item.id as string),
        status: "new",
        createdAt: (item.created_at as string | null) ?? "",
      })),
  ];

  const ranked = searchRows(candidates, q, 8);

  // For the winners only (≤8): pull the SAME compact label the dashboard row
  // shows (itemLabel — brand + model, NOT the long eBay SEO title) plus a signed
  // first-photo thumbnail, so a search result reads identically to its list row.
  // Bounded to the 8 results, so this stays one items lookup + one batch sign.
  const winnerIds = ranked.map((r) => r.itemId);
  const labelByItem = new Map<string, string>();
  const thumbByItem = new Map<string, string>();
  if (winnerIds.length > 0) {
    const { data: winnerItems } = await supabase
      .from("items")
      .select("id, attributes, photos")
      .in("id", winnerIds);
    const photoByItem = new Map<string, string>();
    for (const it of winnerItems ?? []) {
      const id = it.id as string;
      labelByItem.set(id, itemLabel(it.attributes, id));
      const first = (it.photos as string[] | null)?.[0];
      if (first) photoByItem.set(id, first);
    }
    if (photoByItem.size > 0) {
      const { data: signed } = await supabase.storage
        .from("photos")
        .createSignedUrls([...photoByItem.values()], 60 * 10);
      const urlByPath = new Map<string, string>();
      for (const entry of signed ?? []) {
        if (entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl);
      }
      for (const [id, path] of photoByItem) {
        const url = urlByPath.get(path);
        if (url) thumbByItem.set(id, url);
      }
    }
  }

  const results: SearchHit[] = ranked.map(({ itemId, title, status }) => ({
    itemId,
    title: labelByItem.get(itemId) ?? title,
    status,
    thumbUrl: thumbByItem.get(itemId) ?? null,
  }));
  return NextResponse.json({ results });
}

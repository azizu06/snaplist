import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { searchRows } from "@/lib/ui/search";
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
}

export async function GET(request: Request) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const supabase = await createClient();
  const [{ data: listings }, { data: items }] = await Promise.all([
    supabase
      .from("listings")
      .select("id, item_id, title, status, created_at")
      .eq("platform", "ebay")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("items")
      .select("id, attributes, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
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

  const results: SearchHit[] = searchRows(candidates, q, 8).map(
    ({ itemId, title, status }) => ({ itemId, title, status }),
  );
  return NextResponse.json({ results });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { serverErrorJson } from "@/lib/api/errors";

/**
 * GET /api/batch/status?ids=<uuid,uuid,…> — live per-item status for the batch
 * triage list (issue #100). The triage page polls this so its rows reflect DB
 * truth (e.g. a ready `queued` listing becoming `published` after seller action) instead of
 * only the orchestrator's last word.
 *
 * Tenancy: the USER-SCOPED server client + RLS do the scoping — asking about
 * another user's item ids simply returns no rows for them (never leaks
 * existence). Cheap read-only DB lookup, gated by auth; deliberately NOT run
 * through the metered per-minute limiter, which exists for model-backed work —
 * a 5s poll would otherwise starve the batch's own pipeline runs out of the
 * shared per-user bucket.
 */

const MAX_IDS = 50;
const idsSchema = z.array(z.uuid()).min(1).max(MAX_IDS);

interface ItemStatusRow {
  id: string;
  listings: Array<{ status: string; title: string | null; created_at: string; platform: string }>;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get("ids") ?? "";
  const parsed = idsSchema.safeParse(raw.split(",").filter(Boolean));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `ids must be 1–${MAX_IDS} comma-separated item ids` },
      { status: 400 },
    );
  }

  try {
    const { data, error } = await supabase
      .from("items")
      .select("id, listings(status, title, created_at, platform)")
      .in("id", parsed.data);
    if (error) throw error;

    // Newest SALE (ebay) listing per item — export packs persist as
    // 'facebook'/'mercari' rows for the same item and must not shadow it
    // (same pinning as the review page).
    const items = ((data ?? []) as ItemStatusRow[]).map((row) => {
      const newest = row.listings
        .filter((l) => l.platform === "ebay")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
      return {
        id: row.id,
        listingStatus: newest?.status ?? null,
        title: newest?.title ?? null,
      };
    });
    return NextResponse.json({ items });
  } catch (err) {
    return serverErrorJson(
      "batch.status",
      err,
      "Couldn't load batch status. Please try again.",
    );
  }
}

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { loadDashboardRows } from "@/lib/dashboard/rows";
import { DashboardView, type DashboardRow } from "./dashboard-view";
// NOT from dashboard-view: that file is "use client", and a runtime value
// imported across the client boundary arrives as a reference proxy, not the
// array (the post-#52 production outage).
import { DASHBOARD_FILTERS, type DashboardFilterKey } from "./filters";
import {
  archiveListings,
  unarchiveListings,
  deleteItems,
  bulkUpdateListings,
} from "./actions";

/**
 * /dashboard — the seller dashboard (issue #49: the marketing landing now
 * owns `/`; the app lives here). Fetch + render only: the row assembly
 * (newest-eBay-listing-per-item union, latest logged price with the seller
 * override winning, signed thumbnails) lives in `lib/dashboard/rows.ts`,
 * where its invariants are unit-tested. The auth proxy gates the route;
 * the redirect below is defense-in-depth.
 */
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const { filter: rawFilter, q: rawQuery } = await searchParams;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/dashboard");

  const rows: DashboardRow[] = await loadDashboardRows(supabase);

  const counts = {
    draft: rows.filter((r) => r.status === "draft").length,
    attention: rows.filter(
      (r) => r.status === "failed" || r.status === "draft_failed",
    ).length,
    live: rows.filter((r) => r.status === "published").length,
  };

  const filter = DASHBOARD_FILTERS.some((f) => f.key === rawFilter)
    ? (rawFilter as DashboardFilterKey)
    : "all";

  const initialQuery = typeof rawQuery === "string" ? rawQuery : undefined;

  return (
    <DashboardView
      rows={rows}
      counts={counts}
      filter={filter}
      initialQuery={initialQuery}
      archiveAction={archiveListings}
      unarchiveAction={unarchiveListings}
      deleteAction={deleteItems}
      bulkUpdateAction={bulkUpdateListings}
    />
  );
}

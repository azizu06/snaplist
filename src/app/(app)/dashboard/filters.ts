/**
 * Dashboard status filters — in their own module WITHOUT "use client" on
 * purpose. dashboard-view.tsx is a client component, and a runtime value
 * imported from a client module by a server component arrives as a client-
 * reference proxy, not the array — `DASHBOARD_FILTERS.some(...)` then throws
 * in production (the post-#52 /dashboard outage). Both the server page and
 * the client view import it from here instead.
 */
export const DASHBOARD_FILTERS: ReadonlyArray<{
  key: "all" | "review" | "live" | "archived";
  label: string;
  statuses: readonly string[] | null;
}> = [
  { key: "all", label: "All", statuses: null },
  // Everything the SELLER has to act on — a normal draft or one that errored —
  // lives under one section. The automatic states (Scheduled, Processing) need
  // no action, so they stay visible as a card chip but don't earn a tab. This
  // collapses the old five-tab strip (Draft/Queued/Live/Attention) to three.
  { key: "review", label: "Needs review", statuses: ["draft", "draft_failed", "failed"] },
  { key: "live", label: "Live", statuses: ["published"] },
  // Archived = hidden from the working set (Shopify pattern). Shown in "All"
  // with an Archived chip; this tab filters to just them.
  { key: "archived", label: "Archived", statuses: ["archived"] },
];

export type DashboardFilterKey = (typeof DASHBOARD_FILTERS)[number]["key"];

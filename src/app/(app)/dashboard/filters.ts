/**
 * Dashboard status filters — in their own module WITHOUT "use client" on
 * purpose. dashboard-view.tsx is a client component, and a runtime value
 * imported from a client module by a server component arrives as a client-
 * reference proxy, not the array — `DASHBOARD_FILTERS.some(...)` then throws
 * in production (the post-#52 /dashboard outage). Both the server page and
 * the client view import it from here instead.
 */
export const DASHBOARD_FILTERS: ReadonlyArray<{
  key: "all" | "active" | "draft" | "archived";
  label: string;
  statuses: readonly string[] | null;
}> = [
  { key: "all", label: "All", statuses: null },
  // Shopify's Products tab set: All · Active · Draft · Archived. Active = live
  // on eBay (published). Draft folds in everything pre-live and the states that
  // need the seller (a normal draft, one that errored, plus the automatic
  // Processing/Ready-to-publish steps) — nothing live, nothing archived.
  { key: "active", label: "Active", statuses: ["published"] },
  { key: "draft", label: "Draft", statuses: ["draft", "draft_failed", "failed", "new", "queued"] },
  // Archived = hidden from the working set (Shopify pattern). Shown in "All"
  // with an Archived chip; this tab filters to just them.
  { key: "archived", label: "Archived", statuses: ["archived"] },
];

export type DashboardFilterKey = (typeof DASHBOARD_FILTERS)[number]["key"];

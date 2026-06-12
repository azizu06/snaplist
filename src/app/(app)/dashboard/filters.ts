/**
 * Dashboard status filters — in their own module WITHOUT "use client" on
 * purpose. dashboard-view.tsx is a client component, and a runtime value
 * imported from a client module by a server component arrives as a client-
 * reference proxy, not the array — `DASHBOARD_FILTERS.some(...)` then throws
 * in production (the post-#52 /dashboard outage). Both the server page and
 * the client view import it from here instead.
 */
export const DASHBOARD_FILTERS: ReadonlyArray<{
  key: "all" | "draft" | "queued" | "live" | "attention";
  label: string;
  statuses: readonly string[] | null;
}> = [
  { key: "all", label: "All", statuses: null },
  { key: "draft", label: "Draft", statuses: ["draft"] },
  { key: "queued", label: "Queued", statuses: ["queued"] },
  { key: "live", label: "Live", statuses: ["published"] },
  { key: "attention", label: "Needs attention", statuses: ["failed", "draft_failed"] },
];

export type DashboardFilterKey = (typeof DASHBOARD_FILTERS)[number]["key"];

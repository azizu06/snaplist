import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { lifecycleLabel } from "@/lib/ui/status";

/**
 * Dashboard — Shopify products index, replicated (issue #40 round 2; Mobbin
 * Shopify admin reference): page header with a near-black primary action, a
 * metrics strip, then ONE card holding the status tabs row and a real data
 * table (thumbnail · title · status pill · price · created). Mobile collapses
 * the table to Depop-style rows.
 *
 * Pure presentation: the page assembles rows; the preview harness feeds
 * fixtures.
 */

export interface DashboardRow {
  itemId: string;
  listingId: string | null;
  title: string;
  status: string;
  createdAt: string;
  price: number | null;
  thumbUrl: string | null;
}

export interface DashboardCounts {
  draft: number;
  attention: number;
  live: number;
}

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

function Thumb({ url, title }: { url: string | null; title: string }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
    <img
      src={url}
      alt=""
      aria-hidden
      className="size-10 shrink-0 rounded-lg border border-border object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-faint"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
    </span>
  );
}

export function DashboardView({
  rows,
  counts,
  filter,
}: {
  rows: DashboardRow[];
  counts: DashboardCounts;
  filter: (typeof DASHBOARD_FILTERS)[number]["key"];
}) {
  const activeFilter =
    DASHBOARD_FILTERS.find((f) => f.key === filter) ?? DASHBOARD_FILTERS[0];
  const visible = activeFilter.statuses
    ? rows.filter((r) => activeFilter.statuses!.includes(r.status))
    : rows;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {/* ---- page header (Shopify: title left, primary action right) ---- */}
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight text-fg-strong">Listings</h1>
        <Link
          href="/upload"
          className="inline-flex items-center rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
        >
          New listing
        </Link>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          title="List your first item"
          detail="Take a photo of something you want to sell — we'll identify it, research the price, and write the listing for you."
          action={
            <Link
              href="/upload"
              className="inline-flex items-center rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
            >
              New listing
            </Link>
          }
        />
      ) : (
        <>
          {/* ---- metrics strip (Shopify products-index pattern) ---- */}
          <section className="grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-surface shadow-xs">
            {(
              [
                { label: "Drafts to review", value: counts.draft },
                { label: "Needs attention", value: counts.attention },
                { label: "Live", value: counts.live },
              ] as const
            ).map(({ label, value }) => (
              <div key={label} className="px-4 py-3">
                <p className="text-xs font-medium text-muted">{label}</p>
                <p className="mt-0.5 text-lg font-semibold text-fg-strong" data-nums>
                  {value}
                </p>
              </div>
            ))}
          </section>

          {/* ---- main card: tabs + table ---- */}
          <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
            <nav
              aria-label="Filter by status"
              className="flex items-center gap-0.5 border-b border-border px-2 py-1.5"
            >
              {DASHBOARD_FILTERS.map((f) => (
                <Link
                  key={f.key}
                  href={f.key === "all" ? "/" : `/?filter=${f.key}`}
                  aria-current={f.key === filter ? "page" : undefined}
                  className={
                    f.key === filter
                      ? "rounded-lg bg-surface-3 px-3 py-1.5 text-[13px] font-semibold text-fg-strong"
                      : "rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  }
                >
                  {f.label}
                </Link>
              ))}
            </nav>

            {visible.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">
                Nothing under “{activeFilter.label}” — items move here as their
                status changes.
              </p>
            ) : (
              <>
                {/* desktop: Shopify data table */}
                <table className="hidden w-full sm:table">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted">
                      <th className="py-2.5 pl-4 pr-2 font-medium">Product</th>
                      <th className="px-2 py-2.5 font-medium">Status</th>
                      <th className="px-2 py-2.5 text-right font-medium">Price</th>
                      <th className="py-2.5 pl-2 pr-4 text-right font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visible.map((row) => {
                      const chip = lifecycleLabel(row.status);
                      return (
                        <tr key={`${row.itemId}-${row.listingId ?? "item"}`} className="group">
                          <td className="py-2 pl-4 pr-2">
                            <Link
                              href={`/review/${row.itemId}`}
                              className="flex items-center gap-3"
                            >
                              <Thumb url={row.thumbUrl} title={row.title} />
                              <span className="truncate text-[13px] font-semibold text-fg-strong group-hover:underline">
                                {row.title}
                              </span>
                            </Link>
                          </td>
                          <td className="px-2 py-2">
                            {chip ? (
                              <StatusBadge label={chip.label} tone={chip.tone} dot={false} />
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-right text-[13px] text-fg" data-nums>
                            {row.price != null ? `$${row.price}` : "—"}
                          </td>
                          <td className="py-2 pl-2 pr-4 text-right text-[13px] text-muted" data-nums>
                            {row.createdAt
                              ? new Date(row.createdAt).toLocaleDateString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                })
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* mobile: Depop-style rows */}
                <ul className="divide-y divide-border sm:hidden">
                  {visible.map((row) => {
                    const chip = lifecycleLabel(row.status);
                    return (
                      <li key={`m-${row.itemId}-${row.listingId ?? "item"}`}>
                        <Link
                          href={`/review/${row.itemId}`}
                          className="flex items-center gap-3 px-4 py-3"
                        >
                          <Thumb url={row.thumbUrl} title={row.title} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-fg-strong">
                              {row.title}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted" data-nums>
                              {row.price != null ? `$${row.price}` : "No price yet"}
                            </span>
                          </span>
                          {chip ? (
                            <StatusBadge label={chip.label} tone={chip.tone} dot={false} />
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

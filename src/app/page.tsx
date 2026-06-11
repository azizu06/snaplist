import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { lifecycleLabel } from "@/lib/ui/status";

/**
 * Home (audit H-1): signed-out → landing with the product promise; signed-in →
 * the seller dashboard — every item with its lifecycle state, status-filter
 * tabs (H-6), counts that pull the seller toward work needing attention (H-7),
 * and the New listing CTA (H-4). Reads are RLS-scoped to the caller.
 */

const FILTERS: ReadonlyArray<{
  key: "all" | "draft" | "queued" | "live" | "attention";
  label: string;
  statuses: readonly string[] | null;
}> = [
  { key: "all", label: "All", statuses: null },
  { key: "draft", label: "Draft", statuses: ["draft"] },
  { key: "queued", label: "Queued", statuses: ["queued"] },
  { key: "live", label: "Live", statuses: ["published"] },
  {
    key: "attention",
    label: "Needs attention",
    statuses: ["failed", "draft_failed"],
  },
];

type FilterKey = (typeof FILTERS)[number]["key"];

interface DashboardRow {
  itemId: string;
  listingId: string | null;
  title: string;
  status: string;
  createdAt: string;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: rawFilter } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-fg-strong">
          Snap a photo. We price it and write the listing.
        </h1>
        <p className="text-base leading-relaxed text-muted">
          SnapList identifies your item, researches a fair used price with
          sources, and drafts ready-to-post listings for eBay, Facebook
          Marketplace, and Mercari — you stay in control of every word and
          every dollar.
        </p>
        <div>
          <Link
            href="/login"
            className="inline-flex items-center rounded-md bg-accent-solid px-5 py-2.5 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover"
          >
            Get started
          </Link>
        </div>
      </main>
    );
  }

  // The dashboard unions the eBay listing lifecycle rows with items that have
  // no sale listing yet (still processing / legacy) so nothing the seller
  // uploaded can silently disappear from their control surface.
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

  const itemLabel = (attributes: unknown, id: string): string => {
    const parsed = extractedAttributesSchema.safeParse(attributes ?? {});
    if (parsed.success) {
      const a = parsed.data;
      const label = [a.brand, a.model].filter(Boolean).join(" ") || a.title;
      if (label) return label;
    }
    return `Item ${id.slice(0, 8)}`;
  };

  const itemsById = new Map(
    (items ?? []).map((item) => [item.id as string, item] as const),
  );

  // One row per item: keep only the NEWEST eBay listing per item_id (the query
  // is created_at desc, so first occurrence wins). Today the pipeline writes
  // exactly one eBay listing per item, but a future relist must not make an
  // item appear twice — the review page already guards this with limit(1).
  const newestPerItem = new Map<string, NonNullable<typeof listings>[number]>();
  for (const l of listings ?? []) {
    if (!newestPerItem.has(l.item_id as string)) {
      newestPerItem.set(l.item_id as string, l);
    }
  }
  const listedItemIds = new Set(newestPerItem.keys());

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
      };
    }),
    ...(items ?? [])
      .filter((item) => !listedItemIds.has(item.id as string))
      .map((item) => ({
        itemId: item.id as string,
        listingId: null,
        title: itemLabel(item.attributes, item.id as string),
        status: "new",
        createdAt: (item.created_at as string | null) ?? "",
      })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const counts = {
    draft: rows.filter((r) => r.status === "draft").length,
    attention: rows.filter(
      (r) => r.status === "failed" || r.status === "draft_failed",
    ).length,
    live: rows.filter((r) => r.status === "published").length,
  };

  const filter: FilterKey = FILTERS.some((f) => f.key === rawFilter)
    ? (rawFilter as FilterKey)
    : "all";
  const activeFilter = FILTERS.find((f) => f.key === filter)!;
  const visible = activeFilter.statuses
    ? rows.filter((r) => activeFilter.statuses!.includes(r.status))
    : rows;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Your listings
          </h1>
          {rows.length > 0 ? (
            <p className="mt-1 text-sm text-muted">
              {counts.draft > 0 || counts.attention > 0
                ? [
                    counts.draft > 0
                      ? `${counts.draft} draft${counts.draft === 1 ? "" : "s"} to review`
                      : null,
                    counts.attention > 0
                      ? `${counts.attention} need${counts.attention === 1 ? "s" : ""} attention`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : `${counts.live} live · all caught up`}
            </p>
          ) : null}
        </div>
        <Link
          href="/upload"
          className="inline-flex items-center rounded-md bg-accent-solid px-4 py-2 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover"
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
              className="inline-flex items-center rounded-md bg-accent-solid px-4 py-2 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover"
            >
              New listing
            </Link>
          }
        />
      ) : (
        <>
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key === "all" ? "/" : `/?filter=${f.key}`}
                aria-current={f.key === filter ? "page" : undefined}
                className={
                  f.key === filter
                    ? "rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-strong"
                    : "rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                }
              >
                {f.label}
              </Link>
            ))}
          </nav>

          {visible.length === 0 ? (
            <EmptyState
              title={`Nothing under “${activeFilter.label}”`}
              detail="Items move between statuses as they're reviewed and published."
            />
          ) : (
            <Card>
              <ul className="divide-y divide-border">
                {visible.map((row) => {
                  const chip = lifecycleLabel(row.status);
                  return (
                    <li key={`${row.itemId}-${row.listingId ?? "item"}`}>
                      <Link
                        href={`/review/${row.itemId}`}
                        className="flex items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 sm:px-5"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-fg-strong">
                            {row.title}
                          </span>
                          {row.createdAt ? (
                            <span className="mt-0.5 block text-xs text-faint">
                              {new Date(row.createdAt).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          ) : null}
                        </span>
                        {chip ? <StatusBadge label={chip.label} tone={chip.tone} /> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}
    </main>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/badge";
import { lifecycleShortLabel } from "@/lib/ui/status";
import { searchRows } from "@/lib/ui/search";

/**
 * Global search (Shopify admin parity) — the topbar search bar made real.
 * Clicking it (or ⌘K / Ctrl+K) anchors a panel to the bar's live rect, so the
 * bar appears to lift, switch to a crisp neutral, and drop a CONNECTED dropdown
 * (not a detached centered modal). The panel carries Shopify's pieces: an
 * isolated bordered search pill (search glyph · field · clear · filter toggle)
 * that goes white/light against the panel when active, scope chips ("Listings"
 * / "Pages") carrying live result counts, and results grouped by type + a
 * "Search all listings for X" footer that chains into the dashboard's scoped
 * list search.
 *
 * Preview mode: the dev harness has no session (the API would 401), so the
 * layout can pass `fixtures` and the palette searches them locally with the
 * SAME tested matcher the API uses.
 */

export interface PaletteHit {
  itemId: string;
  title: string;
  status: string;
  /** Signed first-photo URL so the result row shows the SAME thumbnail as the
   *  dashboard list row. Null/absent when the item has no photo. */
  thumbUrl?: string | null;
  /** Only used for local fixture ranking; absent on API results. */
  createdAt?: string;
}

/** Navigable "Pages" — the second result type (Shopify scopes search by type;
 *  Listings is the searchable content, Pages are the app's destinations). */
const PAGES = [
  { href: "/upload", label: "New listing" },
  { href: "/dashboard", label: "View all listings" },
  { href: "/inbox", label: "Buyer inbox" },
  { href: "/settings", label: "Settings" },
] as const;

type ScopeKey = "listings" | "pages";
const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: "listings", label: "Listings" },
  { key: "pages", label: "Pages" },
];

export function CommandPalette({ fixtures }: { fixtures?: PaletteHit[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [selected, setSelected] = useState(0);
  // Active scope chip — narrows the result types shown (null = both).
  const [scope, setScope] = useState<ScopeKey | null>(null);
  // The in-input filter button toggles the scope chip row (Shopify's filter
  // affordance). Chips show by default so their result counts stay visible.
  const [showScopes, setShowScopes] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Live rect of the search bar — the panel anchors to it so the bar appears to
  // lift, switch neutral, and drop a CONNECTED dropdown (Shopify).
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestQueryRef = useRef("");

  const trimmed = query.trim();
  const showActions = trimmed === "";
  const searchAllHref = trimmed
    ? `/dashboard?q=${encodeURIComponent(trimmed)}`
    : null;

  // Result groups, gated by the active scope.
  const listingResults = scope === "pages" ? [] : showActions ? [] : hits;
  const pageResults =
    scope === "listings"
      ? []
      : showActions
        ? [...PAGES]
        : PAGES.filter((p) => p.label.toLowerCase().includes(trimmed.toLowerCase()));
  const showFooter = !showActions && scope !== "pages" && searchAllHref != null;

  // Per-scope match counts surfaced on the chips (Shopify's "Listings 6 /
  // Pages 4" indicator) — shown only while searching, and computed independently
  // of the active scope so each chip reports its own matches.
  const pageMatchCount = PAGES.filter((p) =>
    p.label.toLowerCase().includes(trimmed.toLowerCase()),
  ).length;
  const scopeCount = (key: ScopeKey): number | null =>
    trimmed === "" ? null : key === "listings" ? hits.length : pageMatchCount;

  // Flat keyboard-nav order: listings → pages → footer (matches render order).
  // Cheap to recompute per render; the derived arrays above are not stable refs.
  const options: { key: string; href: string }[] = [
    ...listingResults.map((h) => ({ key: h.itemId, href: `/review/${h.itemId}` })),
    ...pageResults.map((p) => ({ key: p.href, href: p.href })),
  ];
  if (showFooter && searchAllHref) options.push({ key: "search-all", href: searchAllHref });

  const openPalette = useCallback((el?: HTMLElement | null) => {
    const target = el ?? triggerRef.current;
    const r = target?.getBoundingClientRect();
    if (r && r.width > 0) {
      // Wide field (desktop): anchor exactly over the bar so it reads as the
      // bar lifting open. Narrow icon (mobile): drop a near-full-width sheet.
      const wide = r.width >= 360;
      setAnchor(
        wide
          ? { top: r.top, left: r.left, width: r.width }
          : { top: r.top, left: 12, width: window.innerWidth - 24 },
      );
    } else {
      const w = Math.min(560, window.innerWidth - 24);
      setAnchor({ top: 64, left: (window.innerWidth - w) / 2, width: w });
    }
    setQuery("");
    setHits([]);
    setScope(null);
    setShowScopes(true);
    setSelected(0);
    setOpen(true);
  }, []);

  // The anchor rect is captured on open; if the viewport changes, close rather
  // than render at a stale position.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setOpen(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // ⌘K / Ctrl+K toggles from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) setOpen(false);
        else openPalette();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, openPalette]);

  // In-flight work dies with the component.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  // Search runs from the change handler, debounced — fixtures (dev preview)
  // search locally with the same tested matcher; production asks the
  // RLS-scoped API.
  const onQueryChange = (value: string) => {
    setQuery(value);
    setSelected(0);
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const q = value.trim();
    latestQueryRef.current = q;
    if (!q) {
      setHits([]);
      return;
    }
    if (fixtures) {
      setHits(
        searchRows(
          fixtures.map((f) => ({ ...f, createdAt: f.createdAt ?? "" })),
          q,
          8,
        ),
      );
      return;
    }
    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as { results?: PaletteHit[] };
        if (latestQueryRef.current !== q) return;
        setHits(body.results ?? []);
        setSelected(0);
      } catch {
        // aborted or offline — keep the last results
      }
    }, 150);
  };

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      const opt = options[selected];
      if (opt) navigate(opt.href);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Running index across the flat options, so keyboard selection and the
  // rendered highlight stay in lockstep across both groups + the footer.
  let optIndex = 0;
  const searchIcon = (
    <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );

  return (
    <>
      {/* trigger — one recessed gray search BAR for mobile + desktop (mobile no
          longer gets a lone centered icon). On open it fades to 0 so the anchored
          panel is the only bar (no doubled border / no shift). The ⌘K hint shows
          only where there's a keyboard (sm+). */}
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => openPalette(e.currentTarget)}
        className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-[14px] shadow-xs transition-all sm:px-3.5 sm:py-2.5 ${
          open
            ? "border-transparent bg-surface text-fg opacity-0"
            : "border-border-strong bg-surface-2 text-muted hover:border-fg-strong/30 hover:bg-surface hover:text-fg hover:shadow-sm"
        }`}
      >
        {searchIcon}
        <span className="truncate">Search listings…</span>
        <kbd className="ml-auto hidden shrink-0 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-[11px] font-semibold leading-none text-muted sm:inline-flex">
          <span aria-hidden className="text-[13px] leading-none">⌘</span>
          <span className="leading-none">K</span>
        </kbd>
      </button>

      {open && anchor ? createPortal(
        <div
          className="fixed inset-0 z-50 bg-[rgba(26,26,26,0.32)] backdrop-blur-[1px]"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          {/* Anchored to the bar's rect: lifts (elevated z + shadow), switches
              to a crisp neutral over the dimmed page, and drops a CONNECTED
              panel — Shopify's global search. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            style={{ position: "fixed", top: anchor.top, left: anchor.left, width: anchor.width }}
            className="menu-pop origin-top overflow-hidden rounded-xl border border-border-strong bg-surface-2 shadow-2xl ring-1 ring-black/5"
          >
            {/* input — isolated, bordered pill (Shopify): search glyph · field ·
                clear · filter toggle. The pill goes white (light) / brightest
                neutral (dark) against the surface-2 panel, so the active typing
                area reads as its own container. */}
            <div className="p-2.5">
              <div className="flex h-[42px] items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-faint transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 dark:bg-surface-3">
                {searchIcon}
                {scope ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-md bg-brand-soft px-2 py-0.5 text-[12.5px] font-semibold text-accent-soft-fg">
                    {SCOPES.find((s) => s.key === scope)?.label}
                    <button
                      type="button"
                      onClick={() => setScope(null)}
                      aria-label="Clear scope"
                      className="-mr-0.5 flex size-4 items-center justify-center rounded hover:bg-accent-soft"
                    >
                      <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ) : null}
                <input
                  ref={inputRef}
                  autoFocus
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder={scope ? `Search ${scope}…` : "Search SnapList…"}
                  aria-label="Search SnapList"
                  className="h-full w-full bg-transparent text-[14px] text-fg-strong outline-none placeholder:text-muted"
                />
                {/* trailing controls — clear · divider · filter, clustered
                    tight (gap-1); the divider only shows alongside the clear. */}
                <span className="flex shrink-0 items-center gap-1">
                  {trimmed ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onQueryChange("")}
                        aria-label="Clear search"
                        className="flex size-5 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong dark:hover:bg-surface-2"
                      >
                        <svg viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <circle cx="12" cy="12" r="9" />
                          <path d="m15 9-6 6M9 9l6 6" />
                        </svg>
                      </button>
                      <span aria-hidden className="h-4 w-px bg-border" />
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setShowScopes((v) => !v)}
                    aria-pressed={showScopes}
                    aria-label="Toggle search filters"
                    className={`flex size-5 items-center justify-center rounded-md transition-colors ${
                      showScopes ? "text-fg-strong" : "text-muted hover:text-fg-strong"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 5h18M6 12h12M10 19h4" />
                    </svg>
                  </button>
                </span>
              </div>
            </div>

            {/* scope chips with live result counts (Shopify's "Listings 6 /
                Pages 4"); toggled by the filter button in the pill above. */}
            {showScopes ? (
              <div className="flex items-center gap-2 px-2.5 pb-3.5 pt-1.5">
                {SCOPES.map((s) => {
                  const on = scope === s.key;
                  const count = scopeCount(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setScope(on ? null : s.key)}
                      className={`flex items-center rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${
                        on
                          ? "bg-accent-solid text-accent-fg"
                          : "bg-surface-3 text-fg hover:bg-border-strong/40"
                      }`}
                    >
                      {s.label}
                      {count != null ? (
                        <span className={`ml-1.5 ${on ? "text-accent-fg/75" : "text-faint"}`} data-nums>
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div role="listbox" aria-label="Results" className="max-h-[56vh] overflow-y-auto border-t border-border p-2">

              {/* Shop results — the scope chip already labels this "Listings",
                  so the group header just reads "Shop results" with its count
                  beside it (no redundant "Listings" mid-panel). Rows mirror the
                  dashboard list: thumbnail + the SAME compact name + status. */}
              {listingResults.length > 0 ? (
                <>
                  <p className="px-2.5 pb-1 pt-2.5 text-[12.5px] font-semibold text-muted">
                    Results <span data-nums>({listingResults.length})</span>
                  </p>
                  {listingResults.map((h) => {
                    const i = optIndex++;
                    const chip = lifecycleShortLabel(h.status);
                    return (
                      <button
                        key={h.itemId}
                        type="button"
                        role="option"
                        aria-selected={selected === i}
                        onClick={() => navigate(`/review/${h.itemId}`)}
                        onPointerMove={() => setSelected(i)}
                        className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors ${
                          selected === i ? "bg-accent-soft" : ""
                        }`}
                      >
                        <span className="size-9 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">
                          {h.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
                            <img src={h.thumbUrl} alt="" aria-hidden className="size-full object-cover" />
                          ) : (
                            <span aria-hidden className="flex size-full items-center justify-center text-faint">
                              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <circle cx="9" cy="9" r="2" />
                                <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                              </svg>
                            </span>
                          )}
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-[14.5px] font-medium ${selected === i ? "text-accent-soft-fg" : "text-fg"}`}>
                          {h.title}
                        </span>
                        {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot={false} /> : null}
                      </button>
                    );
                  })}
                </>
              ) : null}

              {/* Pages group */}
              {pageResults.length > 0 ? (
                <>
                  <p className="px-2.5 pb-1 pt-2 text-[12.5px] font-semibold text-muted">
                    {showActions && !scope ? "Jump to" : "Pages"}
                  </p>
                  {pageResults.map((p) => {
                    const i = optIndex++;
                    return (
                      <button
                        key={p.href}
                        type="button"
                        role="option"
                        aria-selected={selected === i}
                        onClick={() => navigate(p.href)}
                        onPointerMove={() => setSelected(i)}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[15px] transition-colors ${
                          selected === i ? "bg-accent-soft" : ""
                        }`}
                      >
                        <span className={`font-medium ${selected === i ? "text-accent-soft-fg" : "text-fg"}`}>
                          {p.label}
                        </span>
                      </button>
                    );
                  })}
                </>
              ) : null}

              {/* Footer — opens the full dashboard list filtered to this query
                  (a "see all", not another search box): tight row + trailing
                  arrow so it reads as navigation, no leading magnifier. */}
              {showFooter && searchAllHref ? (
                (() => {
                  const i = optIndex++;
                  return (
                    <>
                      <div className="my-1 border-t border-border" />
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected === i}
                        onClick={() => navigate(searchAllHref)}
                        onPointerMove={() => setSelected(i)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors ${
                          selected === i ? "bg-accent-soft" : ""
                        }`}
                      >
                        <span className={selected === i ? "text-accent-soft-fg" : "text-muted"}>
                          See all results for{" "}
                          <span className={`font-semibold ${selected === i ? "" : "text-fg"}`}>“{trimmed}”</span>
                        </span>
                        <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      </button>
                    </>
                  );
                })()
              ) : null}

              {/* Empty result states */}
              {listingResults.length === 0 && pageResults.length === 0 && !showFooter ? (
                <p className="px-2.5 py-5 text-center text-[14px] text-muted">
                  {showActions
                    ? "Type to search your listings."
                    : `No matches for “${trimmed}”.`}
                </p>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

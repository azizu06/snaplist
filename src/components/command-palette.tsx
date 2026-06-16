"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/badge";
import { lifecycleShortLabel } from "@/lib/ui/status";
import { searchRows } from "@/lib/ui/search";

/**
 * ⌘K command palette (dashboard v2) — makes the topbar search real. Open via
 * the trigger or ⌘K/Ctrl+K; type to search the user's listings through
 * /api/search (RLS-scoped), arrow-key + Enter to jump to an item's review
 * page. With no query it offers quick actions instead of dumping inventory.
 *
 * Preview mode: the dev harness has no session (the API would 401), so the
 * layout can pass `fixtures` and the palette searches them locally with the
 * SAME tested matcher the API uses.
 */

export interface PaletteHit {
  itemId: string;
  title: string;
  status: string;
  /** Only used for local fixture ranking; absent on API results. */
  createdAt?: string;
}

const QUICK_ACTIONS = [
  { href: "/upload", label: "New listing", hint: "Photo → priced listing" },
  { href: "/inbox", label: "Open inbox", hint: "Buyer messages" },
  { href: "/dashboard", label: "View listings", hint: "Your inventory" },
  { href: "/settings", label: "Settings", hint: "Autopilot · eBay account" },
] as const;

export function CommandPalette({ fixtures }: { fixtures?: PaletteHit[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestQueryRef = useRef("");

  const showActions = query.trim() === "";

  const openPalette = useCallback(() => {
    setQuery("");
    setHits([]);
    setSelected(0);
    setOpen(true);
  }, []);

  // ⌘K / Ctrl+K toggles from anywhere. Re-registered when `open` flips so
  // the reset stays in plain handler code (state updaters must be pure).
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
    if (timerRef.current) clearTimeout(timerRef.current);
    // Kill any in-flight request NOW — waiting for the debounce timer would
    // let a previous query's response land under the new input (Codex P2).
    abortRef.current?.abort();
    const q = value.trim();
    latestQueryRef.current = q;
    if (!q) {
      setHits([]);
      setSelected(0);
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
      setSelected(0);
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
        // Belt-and-braces staleness check on top of the abort.
        if (latestQueryRef.current !== q) return;
        setHits(body.results ?? []);
        setSelected(0);
      } catch {
        // aborted or offline — keep the last results
      }
    }, 150);
  };

  const options = useMemo(
    () =>
      showActions
        ? QUICK_ACTIONS.map((a) => ({ key: a.href, href: a.href }))
        : hits.map((h) => ({ key: h.itemId, href: `/review/${h.itemId}` })),
    [showActions, hits],
  );

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

  return (
    <>
      {/* desktop trigger — centered, lifted off the bar with a border + shadow
          (so it doesn't read as "embedded in the background") */}
      <button
        type="button"
        onClick={openPalette}
        className="hidden w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-[14px] text-muted shadow-xs transition-all hover:border-border-strong hover:shadow-sm sm:flex"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        Search listings…
        <kbd className="ml-auto rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-faint">
          ⌘K
        </kbd>
      </button>

      {/* mobile trigger — icon only; bottom tabs own primary nav */}
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search listings"
        className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 sm:hidden"
      >
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </button>

      {/* Portaled: the sticky header's backdrop-filter would otherwise become
          the containing block for this fixed overlay and clip it to the bar. */}
      {open ? createPortal(
        <div
          className="fixed inset-0 z-50 bg-[rgba(26,26,26,0.32)] p-4 backdrop-blur-[2px]"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            className="palette-pop mx-auto mt-[10vh] w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search your listings…"
                aria-label="Search your listings"
                className="h-[52px] w-full bg-transparent text-[16px] text-fg-strong outline-none placeholder:text-faint"
              />
              <kbd className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-faint">
                esc
              </kbd>
            </div>

            <div role="listbox" aria-label="Results" className="max-h-[44vh] overflow-y-auto p-2">
              {showActions ? (
                <>
                  <p className="px-2.5 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
                    Quick actions
                  </p>
                  {QUICK_ACTIONS.map((a, i) => (
                    <button
                      key={a.href}
                      type="button"
                      role="option"
                      aria-selected={selected === i}
                      onClick={() => navigate(a.href)}
                      onPointerMove={() => setSelected(i)}
                      className={`flex w-full items-baseline gap-2 rounded-lg px-3 py-2.5 text-left text-[15px] transition-colors ${
                        selected === i ? "bg-accent-soft" : ""
                      }`}
                    >
                      <span className={`font-medium ${selected === i ? "text-accent-soft-fg" : "text-fg"}`}>
                        {a.label}
                      </span>
                      <span className="text-[14px] text-faint">{a.hint}</span>
                    </button>
                  ))}
                </>
              ) : hits.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-[14px] text-muted">
                  No listings match “{query.trim()}”.
                </p>
              ) : (
                hits.map((h, i) => {
                  const chip = lifecycleShortLabel(h.status);
                  return (
                    <button
                      key={h.itemId}
                      type="button"
                      role="option"
                      aria-selected={selected === i}
                      onClick={() => navigate(`/review/${h.itemId}`)}
                      onPointerMove={() => setSelected(i)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        selected === i ? "bg-accent-soft" : ""
                      }`}
                    >
                      <span
                        className={`min-w-0 flex-1 truncate text-[15px] font-medium ${
                          selected === i ? "text-accent-soft-fg" : "text-fg"
                        }`}
                      >
                        {h.title}
                      </span>
                      {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot={false} /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

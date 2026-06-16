"use client";

/**
 * Interactive pricing-waterfall explorer (/how-it-works, ui-r5-marketing).
 * Selecting a tier shows that tier's worked example — animated fills,
 * counting numbers, and source rows that appear in sequence. Stays honest by
 * design: the recent-sales tier uses a real catalog product whose plausible
 * pricing path IS recent sales (the authentic dark-wood convertible crib, via
 * the "hiw-waterfall" surface assignment); the other tiers show their
 * mechanism with concrete worked numbers rather than pinning a product onto
 * a tier that wouldn't fire for it.
 *
 * Copy rule (owner round-5): every visible word reads like plain seller
 * language — no "comps", no "conf", no "category prior". The depreciation
 * tier shows a price-decaying-over-age arc ($200 new in 2021 → $84 today);
 * the best-guess tier shows an honestly wide labeled range.
 */

import Image from "next/image";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import CountUp from "@/components/bits/CountUp";
import {
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "@/lib/demo-products";

type TierId = "isbn" | "comps" | "depreciation" | "llm";

const TIERS: {
  id: TierId;
  name: string;
  when: string;
  confidence: number;
  label: string;
}[] = [
  {
    id: "isbn",
    name: "Exact book lookup",
    when: "Books & media with a readable ISBN on the cover",
    confidence: 96,
    label: "Highest",
  },
  {
    id: "comps",
    name: "Recent sale prices",
    when: "Branded, recognizable items",
    confidence: 84,
    label: "High",
  },
  {
    id: "depreciation",
    name: "New price, marked down",
    when: "Everyday items where only the new price can be found",
    confidence: 52,
    label: "Medium",
  },
  {
    id: "llm",
    name: "Best-guess estimate",
    when: "The last resort: always flagged for your review",
    confidence: 30,
    label: "Low",
  },
];

function SourceRow({
  children,
  value,
  i,
}: {
  children: React.ReactNode;
  value: string;
  i: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 + i * 0.14 }}
      className="flex items-center justify-between rounded-xl border border-line bg-night-2 px-4 py-3"
    >
      <span className="flex items-center gap-2.5 text-[15px] text-flash-dim">
        <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        {children}
      </span>
      <span className="nums text-[15px] font-semibold text-flash">{value}</span>
    </motion.div>
  );
}

function IsbnExample() {
  return (
    <div>
      <div className="flex items-center gap-4 rounded-2xl border border-line bg-night-2 px-5 py-4">
        {/* barcode glyph */}
        <svg viewBox="0 0 48 24" className="h-10 w-[68px] shrink-0 text-flash" aria-hidden>
          {[1, 4, 6, 10, 13, 17, 19, 23, 26, 30, 32, 36, 39, 43, 45].map((x, i) => (
            <rect key={x} x={x} y="2" width={i % 3 === 0 ? 2.4 : 1.3} height="20" fill="currentColor" />
          ))}
        </svg>
        <div>
          <p className="nums text-[16.5px] font-semibold tracking-wide text-flash">
            978-0-596-51582-9
          </p>
          <p className="mt-0.5 text-[14px] text-flash-faint">read straight off the cover photo</p>
        </div>
      </div>
      <div className="mt-4 space-y-2.5">
        <SourceRow i={0} value="exact edition found">
          Open Library: book database
        </SourceRow>
        <SourceRow i={1} value="title &amp; year confirmed">
          Google Books: book database
        </SourceRow>
        <SourceRow i={2} value="sale prices found">
          Recent sales of this exact book
        </SourceRow>
      </div>
      <p className="mt-4 text-[15px] leading-relaxed text-flash-faint">
        When we know the exact book, there is no guessing involved, which is
        why books and media get the most accurate prices of anything you can
        snap.
      </p>
    </div>
  );
}

function CompsExample() {
  const p =
    DEMO_PRODUCTS_BY_SLUG[DEMO_SURFACE_ASSIGNMENTS["hiw-waterfall"][0]];
  return (
    <div>
      <div className="flex items-center gap-4">
        <div className="relative size-[72px] shrink-0 overflow-hidden rounded-2xl">
          <Image src={p.image} alt={p.alt} fill sizes="72px" className="object-cover" />
        </div>
        {/* flex-1 + min-w-0 keeps the long title truncating INSIDE the card —
            without it the row overflows and pushes the price off-canvas. */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold text-flash">{p.title}</p>
          <p className="mt-0.5 text-[14px] text-flash-faint">
            {p.condition} · {p.category}
          </p>
        </div>
        <p className="nums shrink-0 font-display text-[32px] font-bold text-flash">
          $<CountUp to={p.price} duration={0.9} />
        </p>
      </div>
      <div className="mt-4 space-y-2.5">
        <SourceRow i={0} value="$55 · 3 days ago">
          Sold on eBay
        </SourceRow>
        <SourceRow i={1} value="$48 · last week">
          Sold on Facebook, same dark-wood convertible
        </SourceRow>
        <SourceRow i={2} value="$45 · last week">
          Sold on Mercari
        </SourceRow>
      </div>
      <p className="mt-3.5 text-[15px] leading-relaxed text-flash-faint">
        Similar dark-wood convertible cribs sold for{" "}
        <span className="nums font-semibold text-flash-dim">$40–$65</span>{" "}
        recently. Real sale prices count more than asking prices: what
        something sold for beats what someone hoped to get.
      </p>
    </div>
  );
}

function DepreciationExample() {
  const reduced = useReducedMotion();
  // A concrete worked arc: a kitchen mixer bought new in 2021 for $200,
  // marked down year by year to $84 today.
  const points = [
    { year: "2021", value: 200 },
    { year: "2022", value: 161 },
    { year: "2023", value: 128 },
    { year: "2024", value: 103 },
    { year: "Today", value: 84 },
  ] as const;
  const max = points[0].value;
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.12em] text-flash-faint">
            Bought new in 2021
          </p>
          <p className="nums mt-0.5 font-display text-[26px] font-bold leading-none text-flash-dim">
            $200
          </p>
        </div>
        <svg
          viewBox="0 0 24 24"
          className="mb-1 size-5 text-flash-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <div className="text-right">
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.12em] text-iris">
            Worth now · Good condition
          </p>
          <p className="nums mt-0.5 font-display text-[30px] font-bold leading-none text-flash">
            $84
          </p>
        </div>
      </div>

      {/* the value, falling year by year — last bar (today) highlighted */}
      <div className="mt-5 rounded-2xl border border-line bg-night-2 px-5 pb-4 pt-5">
        <div className="flex items-end justify-between gap-2.5 sm:gap-3.5">
          {points.map(({ year, value }, i) => {
            const today = i === points.length - 1;
            return (
              <div key={year} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <span
                  className={`nums text-[13.5px] font-semibold ${
                    today ? "text-iris" : "text-flash-faint"
                  }`}
                >
                  ${value}
                </span>
                <motion.span
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ duration: 0.5, delay: 0.08 + i * 0.09, ease: [0.21, 0.8, 0.32, 1] }}
                  style={{ height: Math.round((value / max) * 104) }}
                  className={`w-full origin-bottom rounded-t-md ${
                    today
                      ? "bg-gradient-to-t from-iris-deep to-iris"
                      : "bg-iris/25"
                  }`}
                />
                <span
                  className={`text-[13.5px] ${
                    today ? "font-semibold text-flash-dim" : "text-flash-faint"
                  }`}
                >
                  {year}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-[15px] leading-relaxed text-flash-faint">
        When nothing like your item has sold recently, we start from what it
        cost new and mark it down for its age and condition. It is clearly
        labeled an estimate, and it always waits for your approval before
        anything goes live.
      </p>
    </div>
  );
}

function LlmExample() {
  const reduced = useReducedMotion();
  // ui-r6: the panel earns its space honestly — the trail of better sources
  // that came up empty, the wide-range slider as the centerpiece, and the
  // flagged-for-review card instead of a closing text wall.
  const tried = [
    { source: "Book barcode", result: "none on the item" },
    { source: "Recent sale prices", result: "nothing close enough" },
    { source: "New price to mark down", result: "couldn’t find one" },
  ] as const;
  return (
    <div>
      <p className="text-[12.5px] font-semibold uppercase tracking-[0.12em] text-flash-faint">
        What we tried first
      </p>
      <div className="mt-2 space-y-1.5">
        {tried.map(({ source, result }, i) => (
          <motion.div
            key={source}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 + i * 0.12 }}
            className="flex items-center justify-between gap-3 rounded-xl border border-line bg-night-2 px-4 py-1.5"
          >
            <span className="flex items-center gap-2.5 text-[14px] text-flash-dim">
              <svg
                viewBox="0 0 24 24"
                className="size-3 shrink-0 text-flash-faint"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
              {source}
            </span>
            <span className="text-right text-[14px] text-flash-faint">{result}</span>
          </motion.div>
        ))}
      </div>

      <div className="mt-3 rounded-2xl border border-line bg-night-2 p-4">
        <p className="text-[13.5px] font-semibold uppercase tracking-[0.12em] text-flash-faint">
          An honestly wide range
        </p>

        {/* the suggested price, labeled and tethered to its spot on the range */}
        <div className="relative mt-3 pb-1 pt-10">
          <div className="absolute left-[46%] top-0 flex -translate-x-1/2 flex-col items-center">
            <span className="whitespace-nowrap rounded-full bg-iris/12 px-3 py-1.5 text-[14px] font-semibold text-iris">
              Our best guess: <span className="nums font-bold">$35</span>
            </span>
            <span aria-hidden className="h-3.5 w-px bg-iris/50" />
          </div>
          <div className="relative h-2.5 rounded-full bg-panel-2">
            <motion.div
              initial={reduced ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.8, ease: [0.21, 0.8, 0.32, 1] }}
              className="absolute inset-y-0 left-[5%] right-[5%] origin-left rounded-full bg-gradient-to-r from-iris/30 via-iris/70 to-iris/30"
            />
            <span className="absolute left-[46%] top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-night bg-iris" />
          </div>
          <div className="mt-2.5 flex justify-between gap-3 text-[14px] leading-snug text-flash-faint">
            <span>
              could sell for as little as{" "}
              <span className="nums font-semibold text-flash-dim">$10</span>
            </span>
            <span className="text-right">
              or as much as{" "}
              <span className="nums font-semibold text-flash-dim">$80</span>
            </span>
          </div>
        </div>
      </div>
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.5 }}
        className="mt-3 flex items-start gap-3 rounded-2xl border border-iris/25 bg-iris/8 px-4 py-3"
      >
        <svg
          viewBox="0 0 24 24"
          className="mt-0.5 size-4 shrink-0 text-iris"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <path d="M4 22v-7" />
        </svg>
        <p className="text-[14px] leading-snug text-flash-faint">
          <span className="font-semibold text-flash">Flagged for your review</span>.{" "}
          A guess this rough never goes live; you set the final price first.
        </p>
      </motion.div>
    </div>
  );
}

const EXAMPLES: Record<TierId, () => React.ReactNode> = {
  isbn: IsbnExample,
  comps: CompsExample,
  depreciation: DepreciationExample,
  llm: LlmExample,
};

export function WaterfallExplorer() {
  const [active, setActive] = useState<TierId>("comps");
  const reduced = useReducedMotion();
  const Example = EXAMPLES[active];
  const tier = TIERS.find((t) => t.id === active)!;
  return (
    <div className="grid items-stretch gap-5 lg:grid-cols-[1fr_480px] lg:gap-8">
      {/* min-w-0 on both grid children: the nowrap (truncate) product title
          would otherwise set the track's min-content and blow the single
          mobile column out past the viewport. flex-col + flex-1 rows let the
          four tiers share the column height, so the stack and the detail
          card always end up exactly even. */}
      <div className="flex min-w-0 flex-col gap-3.5" role="tablist" aria-label="Pricing tiers">
        {TIERS.map(({ id, name, when, confidence, label }) => {
          const selected = id === active;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(id)}
              onMouseEnter={() => setActive(id)}
              onFocus={() => setActive(id)}
              className={`block w-full rounded-2xl border p-5 text-left transition-[border-color,box-shadow,background-color] duration-200 lg:flex lg:flex-1 lg:flex-col lg:justify-center lg:px-6 ${
                selected
                  ? "border-iris/50 bg-panel shadow-card"
                  : "border-line bg-panel/60 hover:border-line-2"
              }`}
            >
              <div className="flex w-full flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-[17.5px] font-semibold text-flash">
                  {name}
                </span>
                <span
                  className={`nums text-[14px] font-semibold transition-colors ${
                    selected ? "text-iris" : "text-flash-faint"
                  }`}
                >
                  {label} · {confidence}%
                </span>
              </div>
              <p className="mt-1.5 text-[15px] text-flash-faint">{when}</p>
              <div className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                <div
                  className={`h-full rounded-full transition-[width,opacity] duration-700 ease-out ${
                    selected
                      ? "bg-gradient-to-r from-iris-deep to-iris opacity-100"
                      : "bg-iris/50 opacity-60"
                  }`}
                  style={{ width: `${confidence}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* worked example for the selected tier — stretches to match the
          four-row stack exactly; content is vertically centered so the
          larger typography fills the panel instead of floating at the top */}
      <div className="glass-panel flex min-w-0 flex-col rounded-3xl p-6 sm:p-7">
        {/* ui-r6: the label gets its own line; the tier name + "how sure"
            chip sit on a second row, so nothing crowds onto one line */}
        <div>
          <p className="text-[13.5px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
            What this looks like on a real item
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <h3 className="font-display text-[19px] font-semibold leading-snug text-flash">
              {tier.name}
            </h3>
            <span className="nums rounded-full bg-iris/12 px-3 py-1 text-[14px] font-bold text-iris">
              <CountUp key={tier.id} to={tier.confidence} duration={0.9} />% sure
            </span>
          </div>
        </div>
        <div className="mt-5 flex min-h-[300px] flex-1 flex-col">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="my-auto w-full"
            >
              <Example />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

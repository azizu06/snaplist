"use client";

/**
 * Interactive pricing-waterfall explorer (/how-it-works, subpages v3).
 * Replaces the static bar chart: selecting a tier shows that tier's worked
 * example — animated bar fill, counting numbers, and source citations that
 * appear in sequence. Stays honest by design: the comps tier uses a real
 * catalog product whose plausible pricing path IS comps (Taylor guitar);
 * the other tiers show their mechanism schematically rather than pinning a
 * product onto a tier that wouldn't fire for it.
 */

import Image from "next/image";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import CountUp from "@/components/bits/CountUp";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

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
    name: "ISBN lookup",
    when: "Books & media with a readable ISBN",
    confidence: 96,
    label: "Highest",
  },
  {
    id: "comps",
    name: "Live comps research",
    when: "Branded, recognizable items",
    confidence: 84,
    label: "High",
  },
  {
    id: "depreciation",
    name: "Depreciation model",
    when: "Generic items where only retail exists",
    confidence: 52,
    label: "Medium",
  },
  {
    id: "llm",
    name: "Model estimate",
    when: "Last resort — clearly labeled",
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
      <span className="flex items-center gap-2.5 text-[13.5px] text-flash-dim">
        <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        {children}
      </span>
      <span className="nums text-[13.5px] font-semibold text-flash">{value}</span>
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
          <p className="nums text-[15.5px] font-semibold tracking-wide text-flash">
            978-0-596-51582-9
          </p>
          <p className="mt-0.5 text-[12.5px] text-flash-faint">read straight off the cover photo</p>
        </div>
      </div>
      <div className="mt-4 space-y-2.5">
        <SourceRow i={0} value="edition matched">
          Open Library — structured lookup
        </SourceRow>
        <SourceRow i={1} value="metadata confirmed">
          Google Books — title, year, format
        </SourceRow>
        <SourceRow i={2} value="exact identity">
          Sold-listing search, seeded by ISBN
        </SourceRow>
      </div>
      <p className="mt-4 text-[13px] leading-relaxed text-flash-faint">
        An exact identity skips estimation entirely — the strongest tier in
        the waterfall, which is why books and media price best.
      </p>
    </div>
  );
}

function CompsExample() {
  const p = DEMO_PRODUCTS_BY_SLUG.guitar;
  return (
    <div>
      <div className="flex items-center gap-4">
        <div className="relative size-[72px] shrink-0 overflow-hidden rounded-2xl">
          <Image src={p.image} alt={p.alt} fill sizes="72px" className="object-cover" />
        </div>
        {/* flex-1 + min-w-0 keeps the long title truncating INSIDE the card —
            without it the row overflows and pushes the price off-canvas. */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-flash">{p.title}</p>
          <p className="mt-0.5 text-[13px] text-flash-faint">
            {p.condition} · {p.category}
          </p>
        </div>
        <p className="nums shrink-0 font-display text-[32px] font-bold text-flash">
          $<CountUp to={p.price} duration={0.9} />
        </p>
      </div>
      <div className="mt-4 space-y-2.5">
        <SourceRow i={0} value="$870 · 2d">
          Reverb sold listing
        </SourceRow>
        <SourceRow i={1} value="$925 · 4d">
          eBay sold, koa cutaway
        </SourceRow>
        <SourceRow i={2} value="$850 · 1w">
          Mercari comp
        </SourceRow>
      </div>
      <p className="nums mt-3.5 text-[13px] text-flash-faint">
        range $780 – $960 · asking prices down-weighted against sold signals
      </p>
    </div>
  );
}

function DepreciationExample() {
  const reduced = useReducedMotion();
  const steps = [
    ["Retail anchor found", "$129"],
    ["× 0.42 condition factor (Good)", ""],
    ["Estimate", "$54"],
  ] as const;
  return (
    <div>
      <div className="space-y-2.5">
        {steps.map(([label, value], i) => (
          <motion.div
            key={label}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 + i * 0.16 }}
            className={`flex items-center justify-between rounded-xl px-4 py-3.5 ${
              i === steps.length - 1
                ? "border border-iris/35 bg-iris/8"
                : "border border-line bg-night-2"
            }`}
          >
            <span className="text-[14px] text-flash-dim">{label}</span>
            {value ? (
              <span className="nums text-[15px] font-bold text-flash">{value}</span>
            ) : null}
          </motion.div>
        ))}
      </div>
      <p className="mt-4 text-[13px] leading-relaxed text-flash-faint">
        When no resale comps exist, retail × a condition curve is the honest
        fallback — labeled as an estimate and held to a lower confidence, so
        it can never sneak past the autopilot gate.
      </p>
    </div>
  );
}

function LlmExample() {
  const reduced = useReducedMotion();
  return (
    <div>
      <div className="rounded-2xl border border-line bg-night-2 p-5">
        <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-flash-faint">
          Category prior · wide range
        </p>
        <div className="relative mt-4 h-2.5 rounded-full bg-panel-2">
          <motion.div
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.8, ease: [0.21, 0.8, 0.32, 1] }}
            className="absolute inset-y-0 left-[6%] right-[8%] origin-left rounded-full bg-gradient-to-r from-iris/30 via-iris/70 to-iris/30"
          />
          <span className="absolute left-[46%] top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-night bg-iris" />
        </div>
        <div className="nums mt-2.5 flex justify-between text-[12px] text-flash-faint">
          <span>$10</span>
          <span>$35 — model&apos;s best guess</span>
          <span>$80</span>
        </div>
      </div>
      <p className="mt-4 text-[13px] leading-relaxed text-flash-faint">
        The last resort, and it says so: a model-only estimate with the widest
        range and the lowest confidence. Always flagged in the review queue —
        never eligible for autopilot.
      </p>
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
                  className={`nums text-[13px] font-semibold transition-colors ${
                    selected ? "text-iris" : "text-flash-faint"
                  }`}
                >
                  {label} · {confidence}%
                </span>
              </div>
              <p className="mt-1.5 text-[14px] text-flash-faint">{when}</p>
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
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
            What this tier looks like
          </p>
          <span className="nums rounded-full bg-iris/12 px-3 py-1.5 text-[12.5px] font-bold text-iris">
            <CountUp key={tier.id} to={tier.confidence} duration={0.9} />% conf
          </span>
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

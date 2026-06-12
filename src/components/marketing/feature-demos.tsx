"use client";

/**
 * Interactive micro-demos for /features (subpages v3). Each one is a small,
 * real interaction — hover-to-inspect extraction, platform tab composer,
 * price report with counting numbers, and a live autopilot threshold — so
 * the page shows the product working instead of describing it.
 *
 * Products come from the verified demo catalog (features pool: polaroid,
 * vinyl, gshock) and are never relabeled. No scale/3D transforms ever touch
 * text-bearing layers (the hover-blur bug); motion here is opacity + small
 * whole-pixel translates.
 */

import Image from "next/image";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import CountUp from "@/components/bits/CountUp";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

/* ------------------------------------------------------- identify (polaroid) */

type Region = {
  label: string;
  box: { left: string; top: string; width: string; height: string };
  /** Tuck the tag inside the box when it sits too close to the frame edge. */
  labelInside?: boolean;
};

// Boxes sit on what the photo actually shows: the rainbow "Polaroid" print on
// the top bar, the "Supercolor … 645 CL" print on the red band, the whole
// body for category, the film door for condition.
const ID_REGIONS: Region[] = [
  { label: "Polaroid", box: { left: "28%", top: "5%", width: "26%", height: "13%" }, labelInside: true },
  { label: "Supercolor 645 CL", box: { left: "26%", top: "64%", width: "48%", height: "20%" } },
  { label: "Instant camera", box: { left: "8%", top: "5%", width: "84%", height: "88%" }, labelInside: true },
  { label: "Good · film door tested", box: { left: "20%", top: "70%", width: "58%", height: "22%" } },
];

/** Hover/focus an extracted attribute to see where the model read it. */
export function IdentifyDemo() {
  const p = DEMO_PRODUCTS_BY_SLUG.polaroid;
  const [active, setActive] = useState(0);
  const region = ID_REGIONS[active];
  return (
    <div className="glass-panel rounded-3xl p-5">
      <div className="relative h-[250px] overflow-hidden rounded-2xl sm:h-[290px]">
        <Image src={p.image} alt={p.alt} fill sizes="440px" className="object-cover" />
        <div
          className="scan-line absolute inset-x-2 top-2 h-[2px] rounded-full bg-gradient-to-r from-transparent via-iris to-transparent"
          style={{ "--scan-range": "220px" } as React.CSSProperties}
        />
        {/* the active attribute's source region */}
        <div
          aria-hidden
          className="absolute rounded-lg border-2 border-iris bg-iris/10 shadow-[0_0_0_4px_rgba(109,74,255,0.12)] transition-all duration-300 ease-out"
          style={region.box}
        >
          <span
            className={`absolute left-0 whitespace-nowrap rounded-md bg-iris px-2 py-1 text-[11px] font-bold text-iris-ink ${
              region.labelInside ? "left-1 top-1" : "-top-6"
            }`}
          >
            {region.label}
          </span>
        </div>
      </div>
      <p className="mt-4 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
        Extracted attributes — hover to inspect
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {ID_REGIONS.map(({ label }, i) => (
          <button
            key={label}
            type="button"
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => setActive(i)}
            className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
              active === i
                ? "bg-iris text-iris-ink"
                : "bg-iris/10 text-iris hover:bg-iris/20"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- price (vinyl LP) */

const VINYL_SOURCES = [
  ["eBay sold listing", "$26", "2d ago"],
  ["Discogs sale · VG+", "$31", "4d ago"],
  ["Mercari comp", "$27", "1w ago"],
] as const;

/** Price report assembling itself: CountUp number, range band, cited rows. */
export function PriceReportDemo() {
  const p = DEMO_PRODUCTS_BY_SLUG.vinyl;
  const reduced = useReducedMotion();
  return (
    <div className="glass-panel rounded-3xl p-6">
      <div className="flex items-center gap-4">
        <div className="relative size-16 shrink-0 overflow-hidden rounded-xl">
          <Image src={p.image} alt={p.alt} fill sizes="64px" className="object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold text-flash">{p.title}</p>
          <p className="mt-0.5 text-[13px] text-flash-faint">
            {p.condition} · {p.category}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
            Suggested price
          </p>
          <p className="nums font-display text-[38px] font-bold leading-tight text-flash">
            $<CountUp to={p.price} duration={0.9} />
          </p>
        </div>
        <span className="mb-1 rounded-full px-3 py-1.5 text-[12px] font-semibold" style={{ background: "var(--tint-cyan-soft)", color: "var(--tint-cyan)" }}>
          <CountUp to={81} duration={0.9} />% confident
        </span>
      </div>
      <motion.div
        initial={reduced ? false : { scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 0.9, ease: [0.21, 0.8, 0.32, 1] }}
        className="mt-3 h-1.5 origin-left rounded-full bg-gradient-to-r from-iris-deep to-iris"
        style={{ width: "72%" }}
      />
      <p className="nums mt-2 text-[12.5px] text-flash-faint">range $22 – $34 · sold signals over asking</p>
      <div className="mt-4 space-y-2">
        {VINYL_SOURCES.map(([src, price, age], i) => (
          <motion.div
            key={src}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.45, delay: 0.25 + i * 0.18 }}
            className="flex items-center justify-between rounded-lg border border-line bg-night-2 px-3.5 py-2.5"
          >
            <span className="flex items-center gap-2 text-[13.5px] text-flash-dim">
              <svg viewBox="0 0 24 24" className="size-3.5 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              {src}
            </span>
            <span className="nums text-[13.5px] font-semibold text-flash">
              {price} <span className="font-normal text-flash-faint">· {age}</span>
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- listings (G-Shock) */

const PLATFORM_TABS = [
  {
    id: "ebay",
    name: "eBay",
    note: "keyword title · item specifics",
    title: "Casio G-Shock DW-5600 Digital Watch — Classic Square, Tested",
    body: (
      <div className="space-y-1.5">
        {[
          ["Brand", "Casio"],
          ["Model", "DW-5600"],
          ["Condition", "Good — tested, keeps time"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-[13.5px]">
            <span className="text-flash-faint">{k}</span>
            <span className="font-medium text-flash-dim">{v}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "facebook",
    name: "Facebook",
    note: "casual · local pickup",
    title: "Casio G-Shock watch — works perfectly",
    body: (
      <p className="text-[13.5px] leading-relaxed text-flash-dim">
        Classic square G-Shock, keeps perfect time. Light wear on the strap,
        glass is clean. Pickup near campus or can meet locally.
      </p>
    ),
  },
  {
    id: "mercari",
    name: "Mercari",
    note: "hashtags · ships next day",
    title: "Casio G-Shock DW-5600 classic square",
    body: (
      <p className="text-[13.5px] leading-relaxed text-flash-dim">
        Tested and working, ships next day in protective wrap.{" "}
        <span className="text-iris">#gshock #casio #watch #edc</span>
      </p>
    ),
  },
] as const;

/** One attribute core → three platform renderings, switched by real tabs. */
export function ListingComposerDemo() {
  const p = DEMO_PRODUCTS_BY_SLUG.gshock;
  const reduced = useReducedMotion();
  const [tab, setTab] = useState(0);
  const t = PLATFORM_TABS[tab];
  return (
    <div className="glass-panel rounded-3xl p-5">
      <div className="flex items-center gap-3.5 px-1">
        <div className="relative size-14 shrink-0 overflow-hidden rounded-xl">
          <Image src={p.image} alt={p.alt} fill sizes="56px" className="object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-flash">{p.title}</p>
          <p className="nums mt-0.5 text-[12.5px] text-flash-faint">
            one validated core · ${p.price}
          </p>
        </div>
      </div>
      <div className="mt-3.5 flex gap-1 rounded-xl bg-night-2 p-1" role="tablist" aria-label="Listing platform">
        {PLATFORM_TABS.map(({ id, name }, i) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === i}
            onClick={() => setTab(i)}
            className={`flex-1 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors ${
              tab === i
                ? "bg-panel text-flash shadow-xs"
                : "text-flash-faint hover:text-flash-dim"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="relative mt-3.5 min-h-[168px]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={t.id}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="rounded-2xl border border-line bg-panel p-5 shadow-xs"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--tint-rose)" }}>
                {t.name}
              </span>
              <span className="nums text-[14px] font-bold text-flash">${p.price}</span>
            </div>
            <p className="mt-2 text-[14.5px] font-semibold leading-snug text-flash">
              {t.title}
            </p>
            <div className="mt-2.5">{t.body}</div>
            <p className="mt-3 text-[12px] text-flash-faint">{t.note}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ autopilot threshold */

const QUEUE_ITEMS = [
  { label: "ISBN exact match", detail: "book, barcode read clean", conf: 94 },
  { label: "Tight comps cluster", detail: "branded, 6 sold signals", conf: 81 },
  { label: "Generic, no brand", detail: "depreciation estimate", conf: 38 },
] as const;

/** Drag the real gate: items publish or queue as the threshold moves. */
export function AutopilotDemo() {
  const [gate, setGate] = useState(85);
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="glass-panel rounded-3xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[15px] font-semibold text-flash">Autopilot gate</p>
          <p className="mt-0.5 text-[12.5px] text-flash-faint">
            publishes above <span className="nums font-semibold text-flash-dim">{gate}%</span> confidence
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle autopilot"
          onClick={() => setEnabled((v) => !v)}
          className={`relative h-5.5 w-10 rounded-full transition-colors ${enabled ? "bg-iris" : "bg-panel-2"}`}
        >
          <span
            className={`absolute top-0.5 size-4.5 rounded-full bg-white shadow-sm transition-[left] duration-200 ${
              enabled ? "left-[calc(100%-1.25rem)]" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <input
        type="range"
        min={40}
        max={95}
        step={1}
        value={gate}
        disabled={!enabled}
        onChange={(e) => setGate(Number(e.target.value))}
        aria-label="Autopilot confidence threshold"
        className="mt-4 w-full accent-[var(--color-iris)] disabled:opacity-40"
      />
      <div className="mt-4 space-y-2">
        {QUEUE_ITEMS.map(({ label, detail, conf }) => {
          const publishes = enabled && conf >= gate;
          return (
            <div
              key={label}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-night-2 px-3.5 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-flash-dim">{label}</p>
                <p className="truncate text-[12px] text-flash-faint">{detail}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="nums text-[13px] font-semibold text-flash-dim">{conf}%</span>
                <span
                  className={`w-[96px] rounded-full px-2 py-1.5 text-center text-[11px] font-bold uppercase tracking-[0.06em] transition-colors ${
                    publishes
                      ? "bg-iris text-iris-ink"
                      : "border border-line-2 text-flash-faint"
                  }`}
                >
                  {publishes ? "publishes" : "queues"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[12.5px] leading-relaxed text-flash-faint">
        Confidence is computed from pricing tier, comp agreement, and ID
        completeness — never the model grading itself.
      </p>
    </div>
  );
}

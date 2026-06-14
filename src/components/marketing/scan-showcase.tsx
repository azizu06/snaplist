"use client";

/**
 * Hero showcase — "one photo in, a defensible listing out", performed live.
 * A photo frame cycles through a montage of verified catalog products (this
 * is a montage surface: reuse across the catalog is deliberate) while a scanning
 * beam sweeps each photo like the vision model reading it; when a scan
 * completes, the output panel updates to that product's real title / price /
 * condition from src/lib/demo-products (labels stay truthful — every entry
 * is vision-verified against its photo).
 *
 * While the beam is mid-sweep the output panel never shows the previous
 * product's listing (owner round-5: stale data during a scan reads as a bug).
 * Instead it shows an "analyzing" placeholder — shimmer skeleton fields plus
 * three working-status rows — and the real listing is revealed only when the
 * beam lands.
 *
 * Motion rules: images crossfade (opacity only), the output panel enters on
 * a whole-pixel translate — no scale/3D transforms ever touch text. Under
 * prefers-reduced-motion the component renders a static first frame with the
 * output already filled in: no beam, no cycling, no skeleton.
 */

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "@/lib/demo-products";

/** The montage products are data-driven from DEMO_SURFACE_ASSIGNMENTS so the
 *  scan set stays in sync with the rest of the catalog and never repeats a
 *  photo another surface already uses. The assigned eight are deliberately
 *  disjoint from the landing carousel and the how-it-works step clips. */
const PRODUCTS = DEMO_SURFACE_ASSIGNMENTS["landing-hero-scan"].map(
  (slug) => DEMO_PRODUCTS_BY_SLUG[slug],
);

/** Beam sweep duration — must match --scan-beam duration in globals.css. */
const SCAN_MS = 2100;
/** Rest after the output updates before the next photo fades in. */
const HOLD_MS = 1900;

function CheckRow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 text-[14px] text-flash-dim">
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="size-3.5 shrink-0 text-iris"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {children}
    </p>
  );
}

/** What the output panel shows while the beam is mid-sweep: shimmer
 *  skeletons where the title/price/condition will land, plus three
 *  working-status rows with staggered pulsing dots. Mirrors the listing
 *  layout so the reveal doesn't jump. */
function AnalyzingPanel() {
  return (
    <div className="mt-5 flex flex-1 flex-col" aria-live="polite">
      <p className="sr-only">Analyzing the photo…</p>
      <div aria-hidden className="space-y-2.5">
        <span className="scan-skel block h-[17px] w-4/5 rounded-md" />
        <span className="scan-skel block h-[17px] w-3/5 rounded-md" />
      </div>
      <div aria-hidden className="mt-4 flex items-center gap-3">
        <span className="scan-skel block h-9 w-28 rounded-lg" />
        <span className="scan-skel block h-[26px] w-24 rounded-full" />
      </div>
      <span aria-hidden className="scan-skel mt-3 block h-[13px] w-2/5 rounded-md" />
      {/* mirror the detail bullets so the reveal doesn't jump */}
      <div aria-hidden className="mt-5 space-y-2.5">
        <span className="scan-skel block h-[13px] w-1/2 rounded-md" />
        <span className="scan-skel block h-[13px] w-2/5 rounded-md" />
        <span className="scan-skel block h-[13px] w-[45%] rounded-md" />
      </div>
      <div className="mt-auto space-y-2.5 border-t border-line pt-5">
        {[
          "Reading the photo",
          "Checking recent sale prices",
          "Drafting the listing",
        ].map((label, i) => (
          <p
            key={label}
            className="flex items-center gap-2.5 text-[14px] text-flash-faint"
          >
            <span
              aria-hidden
              className="scan-think-dot"
              style={{ animationDelay: `${i * 0.4}s` }}
            />
            {label}…
          </p>
        ))}
      </div>
    </div>
  );
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function ScanShowcase() {
  // SSR-safe reduced-motion flag (server snapshot: false → static markup
  // matches the first client frame, then the real preference takes over).
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
  /** Photo currently in the frame (and being scanned). */
  const [active, setActive] = useState(0);
  /** Product whose finished listing the output panel shows — lags `active`
   *  until the beam finishes its pass. `null` until the first sweep lands,
   *  so the panel opens on the analyzing placeholder, never a pre-revealed
   *  listing. While `output !== active` the beam is mid-sweep and the panel
   *  shows the placeholder — stale listings are never visible during a scan. */
  const [output, setOutput] = useState<number | null>(null);

  useEffect(() => {
    if (reduced) return;
    // Beam lands → reveal this product's listing; hold; then advance the
    // frame (which restarts the sweep and flips the panel back to analyzing).
    const reveal = setTimeout(() => setOutput(active), SCAN_MS);
    const advance = setTimeout(
      () => setActive((a) => (a + 1) % PRODUCTS.length),
      SCAN_MS + HOLD_MS,
    );
    return () => {
      clearTimeout(reveal);
      clearTimeout(advance);
    };
  }, [active, reduced]);

  const photo = reduced ? 0 : active;
  const listing = PRODUCTS[reduced ? 0 : (output ?? 0)];
  const analyzing = !reduced && output !== active;

  return (
    <div className="glass-panel grid overflow-hidden rounded-2xl md:grid-cols-[1.12fr_1fr]">
      {/* ------------------------------------------------ the one photo in */}
      <div className="relative aspect-[4/3] md:aspect-auto md:min-h-[460px]">
        {PRODUCTS.map((p, i) => (
          <Image
            key={p.slug}
            src={p.image}
            alt={i === photo ? p.alt : ""}
            fill
            priority={i === 0}
            sizes="(max-width: 768px) 100vw, 560px"
            className={`object-cover transition-opacity duration-500 ${
              i === photo ? "opacity-100" : "opacity-0"
            }`}
          />
        ))}

        {/* viewfinder brackets */}
        <span aria-hidden className="absolute left-3 top-3 size-5 rounded-tl-lg border-l-2 border-t-2 border-white/80 mix-blend-difference" />
        <span aria-hidden className="absolute right-3 top-3 size-5 rounded-tr-lg border-r-2 border-t-2 border-white/80 mix-blend-difference" />
        <span aria-hidden className="absolute bottom-3 left-3 size-5 rounded-bl-lg border-b-2 border-l-2 border-white/80 mix-blend-difference" />
        <span aria-hidden className="absolute bottom-3 right-3 size-5 rounded-br-lg border-b-2 border-r-2 border-white/80 mix-blend-difference" />

        <span className="absolute left-4 top-4 rounded-md bg-night/80 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-flash backdrop-blur dark:bg-night/80">
          One photo in
        </span>

        {/* scanning beam — re-keyed per photo so the sweep restarts in sync
            with each crossfade; the output flips exactly when it lands. */}
        {!reduced && (
          <div key={active} aria-hidden className="scan-showcase-beam">
            <span className="scan-showcase-beam-trail" />
          </div>
        )}
      </div>

      {/* ----------------------------------------- a defensible listing out */}
      <div className="flex flex-col border-t border-line bg-panel p-6 sm:p-7 md:border-l md:border-t-0">
        <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-flash-faint">
          <span
            aria-hidden
            className={`size-1.5 rounded-full bg-iris ${analyzing ? "animate-pulse" : ""}`}
          />
          {analyzing ? "Analyzing the photo" : "A defensible listing out"}
        </p>

        {analyzing ? (
          <AnalyzingPanel />
        ) : (
          <div
            key={reduced ? "static" : output}
            className="scan-output-enter mt-5 flex flex-1 flex-col"
          >
            <p className="font-display text-[17px] font-semibold leading-snug text-flash">
              {listing.title}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="nums font-display text-[36px] font-bold leading-none tracking-tight text-flash">
                ${listing.price}
              </span>
              <span className="rounded-full border border-line bg-night-2 px-3 py-1 text-[13.5px] font-semibold text-flash-dim">
                {listing.condition}
              </span>
            </div>
            <p className="mt-2.5 text-[14px] font-medium text-flash-faint">
              {listing.category} · suggested from the used market
            </p>

            {/* What the model pulled out of the photo — fills the panel with
                real extracted attributes instead of dead space (owner). */}
            <ul className="mt-5 space-y-2">
              {listing.details.map((detail) => (
                <li
                  key={detail}
                  className="flex items-center gap-2.5 text-[15px] text-flash-dim"
                >
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-iris/70"
                  />
                  {detail}
                </li>
              ))}
            </ul>

            <div className="mt-auto space-y-2.5 border-t border-line pt-5">
              <CheckRow>Identified from the photo: brand, model, condition</CheckRow>
              <CheckRow>Priced from recent sale prices, sources cited</CheckRow>
              <CheckRow>Copy drafted for eBay, Facebook &amp; Mercari</CheckRow>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Marketing visuals (subpages v3) — server-safe product mocks shared by the
 * marketing pages. Products come exclusively from the verified demo catalog
 * (src/lib/demo-products.ts) and are never relabeled; each page draws from
 * its assigned pool so no item repeats across surfaces. The Canon camera is
 * reserved for the landing hero video and appears nowhere here.
 *
 * Hover affordances are translate/shadow-only: scale and 3D rotations on
 * text-bearing layers rasterize glyphs at subpixel positions (the "blurry
 * hover" bug), so transforms here move whole pixels with a GPU hint and
 * scaling is reserved for imagery.
 */

import Image from "next/image";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

/* ---------------------------------------------------------------- shared */

/** Faint concentric lens rings — decorative anchor for hero corners. */
export function LensRings({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 600 600" className={className} aria-hidden fill="none">
      {[290, 240, 190, 145, 105].map((r, i) => (
        <circle
          key={r}
          cx="300"
          cy="300"
          r={r}
          stroke="currentColor"
          strokeWidth={i === 2 ? 1.5 : 1}
          opacity={0.05 + i * 0.02}
        />
      ))}
      <circle cx="300" cy="300" r="60" stroke="currentColor" strokeWidth="1.5" opacity="0.18" strokeDasharray="4 7" />
    </svg>
  );
}

export type SpectrumTint = "violet" | "cyan" | "rose" | "indigo";

const TINT_VAR: Record<SpectrumTint, { ink: string; soft: string }> = {
  violet: { ink: "var(--tint-violet)", soft: "var(--tint-violet-soft)" },
  cyan: { ink: "var(--tint-cyan)", soft: "var(--tint-cyan-soft)" },
  rose: { ink: "var(--tint-rose)", soft: "var(--tint-rose-soft)" },
  indigo: { ink: "var(--tint-indigo)", soft: "var(--tint-indigo-soft)" },
};

/**
 * Numbered section eyebrow with a short tinted rule — the affordance system
 * that replaces the repeated violet pill chip. Each capability area keys to
 * one band of the prism spectrum.
 */
export function Eyebrow({
  n,
  tint = "violet",
  children,
}: {
  n?: string;
  tint?: SpectrumTint;
  children: React.ReactNode;
}) {
  const t = TINT_VAR[tint];
  return (
    <p
      className="eyebrow-rule inline-flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-[0.16em]"
      style={{ color: t.ink, "--eyebrow-tint": t.ink } as React.CSSProperties}
    >
      {n ? <span className="nums opacity-60">{n}</span> : null}
      {children}
    </p>
  );
}

/** Compact icon + phrase chip — replaces paragraph bullets on /features. */
export function PointChip({
  tint = "violet",
  icon,
  children,
}: {
  tint?: SpectrumTint;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = TINT_VAR[tint];
  return (
    <span className="inline-flex items-center gap-2.5 rounded-xl border border-line bg-panel py-2 pl-2 pr-3.5 text-[13px] font-medium text-flash-dim shadow-xs">
      <span
        className="flex size-7 items-center justify-center rounded-lg"
        style={{ background: t.soft, color: t.ink }}
      >
        {icon}
      </span>
      {children}
    </span>
  );
}

/* ----------------------------------------------------- about page (mixer) */

/**
 * Refined mini price report — the about hero visual: a miniature of the real
 * product experience. KitchenAid mixer from the verified catalog; comps-tier
 * story (its honest pricing path), range band, confidence chip, cited rows.
 */
export function MiniPriceReport() {
  const p = DEMO_PRODUCTS_BY_SLUG.mixer;
  const sources = [
    ["eBay sold listing", "$179", "3d ago"],
    ["Mercari recent sale", "$192", "5d ago"],
    ["Facebook ask — down-weighted", "$210", "1w ago"],
  ] as const;
  return (
    <div className="glass-panel overflow-hidden rounded-3xl">
      <div className="relative h-[150px]">
        <Image
          src={p.image}
          alt={p.alt}
          fill
          sizes="400px"
          className="object-cover"
        />
        <span className="absolute left-3 top-3 rounded-full bg-night/85 px-2.5 py-1 text-[10.5px] font-semibold text-flash backdrop-blur">
          {p.category}
        </span>
      </div>
      <div className="p-5">
        <p className="text-[13px] font-semibold leading-snug text-flash">
          {p.title}
        </p>
        <div className="mt-3.5 flex items-end justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
              Suggested price
            </p>
            <p className="nums font-display text-[32px] font-bold leading-tight text-flash">
              ${p.price}
            </p>
          </div>
          <span className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-iris/12 px-2.5 py-1 text-[10.5px] font-semibold text-iris">
            <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            78% · recent sales
          </span>
        </div>
        {/* range band — suggested sits inside the researched window */}
        <div className="relative mt-3 h-2 rounded-full bg-panel-2">
          <div className="absolute inset-y-0 left-[18%] right-[14%] rounded-full bg-gradient-to-r from-iris-deep/70 to-iris" />
          <span className="absolute left-[52%] top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-night bg-iris shadow-sm" />
        </div>
        <div className="nums mt-1.5 flex justify-between text-[10.5px] text-flash-faint">
          <span>$150</span>
          <span>range</span>
          <span>$220</span>
        </div>
        <div className="mt-4 space-y-1.5 border-t border-line pt-3.5">
          {sources.map(([src, price, age]) => (
            <div key={src} className="flex items-center justify-between text-[11.5px]">
              <span className="flex items-center gap-2 text-flash-dim">
                <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                {src}
              </span>
              <span className="nums font-semibold text-flash">
                {price} <span className="font-normal text-flash-faint">· {age}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------- how-it-works hero (Game Boy) */

/**
 * Snap → identity mock for the how-it-works hero: one pool photo with the
 * extracted-attribute chips the pipeline would produce. Ambient scan line
 * only — no hover transforms near text.
 */
export function SnapIdentityCard() {
  const p = DEMO_PRODUCTS_BY_SLUG.gameboy;
  return (
    <div className="glass-panel rounded-3xl p-4">
      <div className="relative overflow-hidden rounded-2xl">
        <div className="relative h-[180px]">
          <Image src={p.image} alt={p.alt} fill sizes="380px" className="object-cover" />
          <div
            className="scan-line absolute inset-x-2 top-2 h-[2px] rounded-full bg-gradient-to-r from-transparent via-iris to-transparent"
            style={{ "--scan-range": "164px" } as React.CSSProperties}
          />
          <span aria-hidden className="absolute left-2 top-2 size-4 rounded-tl-lg border-l-2 border-t-2 border-iris/80" />
          <span aria-hidden className="absolute right-2 top-2 size-4 rounded-tr-lg border-r-2 border-t-2 border-iris/80" />
          <span aria-hidden className="absolute bottom-2 left-2 size-4 rounded-bl-lg border-b-2 border-l-2 border-iris/80" />
          <span aria-hidden className="absolute bottom-2 right-2 size-4 rounded-br-lg border-b-2 border-r-2 border-iris/80" />
        </div>
      </div>
      <div className="mt-3.5 flex flex-wrap gap-1.5">
        {["Nintendo", "Game Boy Color", "Dandelion", "Good · tested"].map((chip) => (
          <span
            key={chip}
            className="rounded-md bg-iris/10 px-2 py-1 text-[11px] font-medium text-iris"
          >
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between rounded-xl bg-night-2 px-3 py-2.5">
        <span className="text-[11.5px] text-flash-faint">Priced from recent sales</span>
        <span className="nums text-[14px] font-bold text-flash">${p.price}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------ features page duo cards */

/**
 * Buyer question → grounded draft reply. Continues the page's G-Shock
 * narrative in text only (the photo appears once, in the listing composer).
 */
export function BuyerReplyCard() {
  return (
    <div className="glass-panel h-full rounded-2xl p-5">
      <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-line bg-night-2 px-3.5 py-2.5">
        <p className="text-[10.5px] font-semibold text-flash-faint">buyer · via eBay</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-flash-dim">
          Is this the DW-5600 with the backlight? Does it keep time okay?
        </p>
      </div>
      <div className="ml-auto mt-3 max-w-[90%] rounded-2xl rounded-br-md border border-iris/30 bg-iris/10 px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-[10.5px] font-semibold text-iris">
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2m0-12.8-2.2 2.2M7.8 16.2l-2.2 2.2" />
          </svg>
          drafted from item attributes — awaiting your approval
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-flash-dim">
          Yes — DW-5600E with the EL backlight, and it keeps accurate time.
          Light wear on the strap, glass is clean. Happy to send more photos!
        </p>
      </div>
      <div className="mt-3.5 flex justify-end gap-2">
        <span className="rounded-full border border-line-2 px-3.5 py-1.5 text-[11.5px] font-medium text-flash-dim">
          Edit
        </span>
        <span className="rounded-full bg-iris px-3.5 py-1.5 text-[11.5px] font-semibold text-iris-ink">
          Approve &amp; send
        </span>
      </div>
    </div>
  );
}

/** Per-account isolation rows — row-level security made visible. */
export function IsolationCard() {
  return (
    <div className="glass-panel h-full rounded-2xl p-5">
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
        <svg viewBox="0 0 24 24" className="size-3.5 text-iris" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        row-level security · enforced by Postgres
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between rounded-lg border border-iris/35 bg-iris/8 px-3 py-2.5">
          <span className="flex items-center gap-2.5 text-[12.5px] font-medium text-flash">
            <span className="flex size-6 items-center justify-center rounded-full bg-iris text-[10px] font-bold text-iris-ink">
              you
            </span>
            G-Shock DW-5600 · $42 · live
          </span>
          <span className="text-[10.5px] font-semibold text-iris">visible</span>
        </div>
        {["u2", "u3"].map((u) => (
          <div
            key={u}
            className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 opacity-50"
          >
            <span className="flex items-center gap-2.5 text-[12.5px] text-flash-faint">
              <span className="flex size-6 items-center justify-center rounded-full bg-panel-2 text-[10px] font-bold text-flash-faint">
                {u}
              </span>
              <span className="select-none blur-[5px]">someone else&apos;s listing</span>
            </span>
            <span className="flex items-center gap-1 text-[10.5px] font-semibold text-flash-faint">
              <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              denied
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

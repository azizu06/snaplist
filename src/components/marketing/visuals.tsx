/**
 * Marketing visuals (issue #49 round 2, react-bits round 2 polish) — compact,
 * server-safe product mocks so no page is a wall of text. Identification and
 * publish mocks use the real demo photos (public/demo) instead of line-art
 * icons; the platform cards sit FLAT (resting 3D rotation rasterized text
 * blurry) and only tilt on hover via react-bits TiltedCard. Example listings
 * span distinct products — camera, textbook, sneakers, vinyl — so the mocks
 * never repeat one item. Entrance animation comes from the surrounding
 * <Reveal>; ambient motion from CSS keyframes (reduced-motion safe).
 */

import Image from "next/image";
import TiltedCard from "@/components/bits/TiltedCard";

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

/** Stage 1 — the Mercari-style photo slot strip. */
export function PhotoSlotsVisual() {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
        Add photos
      </p>
      <div className="mt-3 grid grid-cols-4 gap-2.5">
        <div className="relative aspect-square overflow-hidden rounded-xl border border-iris/40">
          <Image
            src="/demo/camera.jpg"
            alt=""
            fill
            sizes="120px"
            className="object-cover"
          />
          <span className="absolute left-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-iris text-[9px] font-bold text-iris-ink">
            1
          </span>
        </div>
        {[2, 3, 4].map((n) => (
          <div
            key={n}
            className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-line-2 text-flash-faint"
          >
            <span className="text-[10px] font-semibold">{n}</span>
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex items-center gap-2 rounded-xl bg-iris/10 px-3 py-2">
        <span className="size-1.5 rounded-full bg-iris" />
        <p className="text-[11.5px] font-medium text-iris">
          ISBN 978-0-13-468599-1 detected on photo 1
        </p>
      </div>
    </div>
  );
}

/** Stage 2 — scan beam over a real product photo, attributes extracted. */
export function ScanChipsVisual() {
  return (
    <div className="glass-panel relative overflow-hidden rounded-2xl p-5">
      <div className="relative mx-auto w-[230px] rounded-xl border border-line-2 bg-night-2 p-2.5">
        <span aria-hidden className="absolute left-1 top-1 z-10 size-3.5 rounded-tl border-l-2 border-t-2 border-iris/80" />
        <span aria-hidden className="absolute right-1 top-1 z-10 size-3.5 rounded-tr border-r-2 border-t-2 border-iris/80" />
        <span aria-hidden className="absolute bottom-1 left-1 z-10 size-3.5 rounded-bl border-b-2 border-l-2 border-iris/80" />
        <span aria-hidden className="absolute bottom-1 right-1 z-10 size-3.5 rounded-br border-b-2 border-r-2 border-iris/80" />
        <div className="relative h-[150px] overflow-hidden rounded-lg">
          <Image
            src="/demo/camera.jpg"
            alt="Canon AE-1 Program film camera being identified"
            fill
            sizes="230px"
            className="object-cover"
          />
          <div
            className="scan-line absolute inset-x-1 top-1 h-[2px] rounded-full bg-gradient-to-r from-transparent via-iris to-transparent"
            style={{ "--scan-range": "140px" } as React.CSSProperties}
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {["Canon AE-1 Program", "Film camera", "Good · tested", "FD 50mm f/1.8"].map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-iris/30 bg-iris/10 px-2.5 py-1 text-[11px] font-medium text-iris"
          >
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Stage 3 — the price module with range + cited sources (vinyl record). */
export function PriceModuleVisual() {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
            Suggested price
          </p>
          <p className="nums font-display text-[30px] font-bold leading-tight text-flash">
            $52
          </p>
        </div>
        <span className="rounded-full bg-iris/15 px-2.5 py-1 text-[10.5px] font-semibold text-iris">
          89% confident
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div className="h-full w-[72%] rounded-full bg-gradient-to-r from-iris-deep to-iris" />
      </div>
      <p className="mt-1.5 text-[11px] text-flash-faint">range $38 – $64 · vinyl, VG+ with sleeve</p>
      <div className="mt-4 space-y-2">
        {[
          ["eBay sold listing", "$49", "2d ago"],
          ["Discogs sale, VG+", "$55", "4d ago"],
          ["Mercari comp", "$50", "1w ago"],
        ].map(([src, price, age]) => (
          <div
            key={src}
            className="flex items-center justify-between rounded-lg border border-line bg-night-2 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-[12px] text-flash-dim">
              <svg viewBox="0 0 24 24" className="size-3 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              {src}
            </span>
            <span className="nums text-[12px] font-semibold text-flash">
              {price} <span className="font-normal text-flash-faint">· {age}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stage 4 — three platform listings, distinct products. Cards rest FLAT
 *  (a permanent rotate-y rasterized the copy blurry) and only tilt on hover. */
export function PlatformCardsVisual() {
  const cards = [
    {
      platform: "eBay",
      title: "Canon AE-1 Program 35mm Film Camera w/ FD 50mm f/1.8 — Tested",
      price: "$128",
      tone: "border-iris/40",
      note: "Item specifics · keyword title",
    },
    {
      platform: "Facebook",
      title: "Organic Chemistry 6th ed. — clean pages, no highlighting. Pickup near campus",
      price: "$45",
      tone: "border-line-2",
      note: "Casual · local pickup",
    },
    {
      platform: "Mercari",
      title: "Air Jordan 1 Mid, sz 10.5 #jordan1 #sneakers — ships next day",
      price: "$164",
      tone: "border-line-2",
      note: "Hashtags · shipping-first",
    },
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map(({ platform, title, price, tone, note }) => (
        <TiltedCard key={platform} className="h-full" rotateAmplitude={6} scaleOnHover={1.04}>
          <div className={`glass-panel h-full rounded-2xl border p-4 ${tone}`}>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-iris">
                {platform}
              </span>
              <span className="nums text-[13px] font-bold text-flash">{price}</span>
            </div>
            <p className="mt-2.5 line-clamp-3 text-[12px] leading-relaxed text-flash-dim">
              {title}
            </p>
            <p className="mt-3 text-[10.5px] text-flash-faint">{note}</p>
          </div>
        </TiltedCard>
      ))}
    </div>
  );
}

/** Stage 5 — published listing + autopilot toggle. */
export function PublishVisual() {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-center justify-between rounded-xl border border-line bg-night-2 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative size-10 overflow-hidden rounded-lg border border-line">
            <Image
              src="/demo/camera.jpg"
              alt=""
              fill
              sizes="40px"
              className="object-cover"
            />
          </div>
          <div>
            <p className="text-[12.5px] font-semibold text-flash">Canon AE-1 Program</p>
            <p className="nums text-[11.5px] text-flash-faint">$128 · eBay</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-iris/40 bg-night px-2.5 py-1 text-[10px] font-bold text-iris">
          <span className="size-1.5 rounded-full bg-iris" />
          LIVE
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-xl bg-iris/8 px-4 py-3">
        <div>
          <p className="text-[12px] font-semibold text-flash">Autopilot</p>
          <p className="text-[11px] text-flash-faint">publishes above 85% confidence</p>
        </div>
        <span className="relative h-5 w-9 rounded-full bg-iris">
          <span className="absolute right-0.5 top-0.5 size-4 rounded-full bg-white" />
        </span>
      </div>
    </div>
  );
}

/** Confidence gauge + the three signals feeding it. */
export function ConfidenceGaugeVisual() {
  // Arc: r=54, semicircle length ≈ 169.6; 92% ≈ 156.
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mx-auto w-[180px]">
        <svg viewBox="0 0 140 84" className="w-full" aria-hidden>
          {/* Track + label use tokens via style (SVG presentation attributes
              can't resolve var()), so the gauge flips with the theme. */}
          <path d="M 16 76 A 54 54 0 0 1 124 76" fill="none" style={{ stroke: "var(--color-panel-2)" }} strokeWidth="10" strokeLinecap="round" />
          <path
            d="M 16 76 A 54 54 0 0 1 124 76"
            fill="none"
            stroke="url(#gauge-grad)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray="156 170"
          />
          <defs>
            <linearGradient id="gauge-grad" x1="16" y1="76" x2="124" y2="76" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#4f5abf" />
              <stop offset="1" stopColor="#8b5cf6" />
            </linearGradient>
          </defs>
          <text x="70" y="66" textAnchor="middle" className="nums" style={{ fill: "var(--color-flash)" }} fontSize="24" fontWeight="700">
            92%
          </text>
        </svg>
      </div>
      <div className="mt-2 space-y-2">
        {[
          ["Pricing tier", "ISBN exact lookup", "w-[95%]"],
          ["Comp agreement", "tight cluster", "w-[84%]"],
          ["Identification", "brand + model + code", "w-[91%]"],
        ].map(([label, detail, w]) => (
          <div key={label} className="rounded-lg border border-line bg-night-2 px-3 py-2">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-medium text-flash-dim">{label}</span>
              <span className="text-flash-faint">{detail}</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-2">
              <div className={`h-full ${w} rounded-full bg-iris/80`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Buyer question → grounded draft reply. */
export function InboxVisual() {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-line bg-night-2 px-3.5 py-2.5">
        <p className="text-[10.5px] font-semibold text-flash-faint">buyer · via eBay</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-flash-dim">
          Is this the 6th edition? And is there any highlighting inside?
        </p>
      </div>
      <div className="ml-auto mt-3 max-w-[88%] rounded-2xl rounded-br-md border border-iris/30 bg-iris/10 px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-[10.5px] font-semibold text-iris">
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2m0-12.8-2.2 2.2M7.8 16.2l-2.2 2.2" />
          </svg>
          drafted from item attributes — awaiting your approval
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-flash-dim">
          Yes — 6th edition, the ISBN in the photos confirms it. Pages are
          clean with no highlighting or notes, just light shelf wear on the
          cover. Happy to send more photos!
        </p>
      </div>
      <div className="mt-3.5 flex justify-end gap-2">
        <span className="rounded-full border border-line-2 px-3.5 py-1.5 text-[11.5px] font-medium text-flash-dim">
          Edit
        </span>
        <span className="rounded-full bg-iris px-3.5 py-1.5 text-[11.5px] font-semibold text-iris-ink">
          Approve & send
        </span>
      </div>
    </div>
  );
}

/** Per-account isolation rows. */
export function SecurityVisual() {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
        <svg viewBox="0 0 24 24" className="size-3.5 text-iris" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            Air Jordan 1 Mid · $164 · live
          </span>
          <span className="text-[10.5px] font-semibold text-iris">visible</span>
        </div>
        {["a", "b"].map((u) => (
          <div
            key={u}
            className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 opacity-50"
          >
            <span className="flex items-center gap-2.5 text-[12.5px] text-flash-faint">
              <span className="flex size-6 items-center justify-center rounded-full bg-panel-2 text-[10px] font-bold text-flash-faint">
                {u === "a" ? "u2" : "u3"}
              </span>
              <span className="select-none blur-[5px]">Sony A6000 · $415 · draft</span>
            </span>
            <span className="flex items-center gap-1 text-[10.5px] font-semibold text-flash-faint">
              <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

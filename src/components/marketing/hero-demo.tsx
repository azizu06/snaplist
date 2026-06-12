"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

/**
 * Hero pipeline demo (issue #49) — the product story as one looping GSAP
 * timeline: photo → identify (scan + attribute chips) → price (count-up with
 * range + sources) → assembled listing, published. Pure CSS/SVG scene; no
 * image assets. Reduced motion gets the final assembled frame, static.
 */

const CHIPS = [
  "Canon AE-1 Program",
  "35mm film camera",
  "Condition: good · tested",
  "FD 50mm f/1.8 lens",
] as const;

function CameraArt({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 130"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* body */}
      <rect x="18" y="38" width="164" height="74" rx="10" />
      {/* top plate + prism hump */}
      <path d="M18 52h54l10-14h36l10 14h54" />
      <path d="M78 38v-8a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v8" />
      {/* lens */}
      <circle cx="100" cy="78" r="26" />
      <circle cx="100" cy="78" r="16" />
      <circle cx="100" cy="78" r="7" />
      {/* controls */}
      <circle cx="44" cy="58" r="7" />
      <rect x="142" y="50" width="22" height="9" rx="3" />
      {/* strap lugs */}
      <path d="M18 70h-5M187 70h-5" />
    </svg>
  );
}

export function HeroDemo() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(scope);
      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: reduce)", () => {
        // Static final frame: listing assembled, everything else parked.
        gsap.set(q("[data-photo], [data-scan], [data-chip], [data-price]"), {
          autoAlpha: 0,
        });
        gsap.set(q("[data-listing]"), { autoAlpha: 1, y: 0 });
        gsap.set(q("[data-live]"), { autoAlpha: 1 });
      });

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const price = { v: 0 };
        const priceEl = scope.current?.querySelector("[data-price-num]");

        const tl = gsap.timeline({
          repeat: -1,
          repeatDelay: 2.2,
          defaults: { ease: "power3.out" },
        });

        tl.set(q("[data-chip], [data-price], [data-listing], [data-live]"), {
          autoAlpha: 0,
        })
          .set(q("[data-scan]"), { autoAlpha: 0, top: "8%" })
          .set(q("[data-photo]"), { autoAlpha: 0, y: 26, rotate: -3 })
          // 1 — the photo lands
          .to(q("[data-photo]"), { autoAlpha: 1, y: 0, rotate: 0, duration: 0.7 })
          // 2 — scan sweep
          .to(q("[data-scan]"), { autoAlpha: 1, duration: 0.2 }, "+=0.3")
          .to(q("[data-scan]"), { top: "88%", duration: 1.1, ease: "power1.inOut" })
          .to(q("[data-scan]"), { autoAlpha: 0, duration: 0.2 }, "-=0.1")
          // 3 — attributes pop out
          .from(
            q("[data-chip]"),
            {
              autoAlpha: 0,
              scale: 0.7,
              y: 10,
              duration: 0.45,
              stagger: 0.13,
              ease: "back.out(2)",
              immediateRender: false,
            },
            "-=0.35",
          )
          .set(q("[data-chip]"), { autoAlpha: 1 })
          // 4 — price counts up
          .to(q("[data-price]"), { autoAlpha: 1, y: 0, duration: 0.45 }, "+=0.25")
          .to(
            price,
            {
              v: 128,
              duration: 1.0,
              ease: "power2.out",
              onUpdate: () => {
                if (priceEl) priceEl.textContent = `$${Math.round(price.v)}`;
              },
            },
            "<",
          )
          .from(
            q("[data-range-fill]"),
            { scaleX: 0, transformOrigin: "left", duration: 0.8, immediateRender: false },
            "<+=0.15",
          )
          // 5 — listing assembles; inputs collapse away
          .to(
            q("[data-photo], [data-chip], [data-price]"),
            { autoAlpha: 0, y: -18, duration: 0.45, stagger: 0.02 },
            "+=1.1",
          )
          .fromTo(
            q("[data-listing]"),
            { autoAlpha: 0, y: 30, scale: 0.96 },
            { autoAlpha: 1, y: 0, scale: 1, duration: 0.65 },
            "-=0.15",
          )
          // 6 — it goes live
          .fromTo(
            q("[data-live]"),
            { autoAlpha: 0, scale: 0.6 },
            { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(2.5)" },
            "+=0.5",
          );

        return () => tl.kill();
      });
    },
    { scope },
  );

  return (
    <div
      ref={scope}
      className="glass-panel relative h-[440px] w-full max-w-[420px] overflow-hidden rounded-3xl p-5"
      aria-label="Demo: a photo becomes a priced, published listing"
    >
      {/* faux window chrome */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-panel-2" />
          <span className="size-2.5 rounded-full bg-panel-2" />
          <span className="size-2.5 rounded-full bg-panel-2" />
        </div>
        <span className="rounded-full border border-line px-2.5 py-1 text-[10.5px] font-medium tracking-wide text-flash-faint">
          snaplist · live demo
        </span>
      </div>

      {/* ---- stage 1: the photo ---- */}
      <div
        data-photo
        className="absolute left-1/2 top-[64px] w-[270px] -translate-x-1/2 rounded-2xl border border-line-2/60 bg-gradient-to-br from-panel-2 to-night-2 p-5 shadow-[0_16px_40px_-12px_rgba(0,0,0,.7)]"
      >
        {/* viewfinder brackets */}
        <span aria-hidden className="absolute left-2.5 top-2.5 size-4 border-l-2 border-t-2 border-iris/80 rounded-tl" />
        <span aria-hidden className="absolute right-2.5 top-2.5 size-4 border-r-2 border-t-2 border-iris/80 rounded-tr" />
        <span aria-hidden className="absolute bottom-2.5 left-2.5 size-4 border-b-2 border-l-2 border-iris/80 rounded-bl" />
        <span aria-hidden className="absolute bottom-2.5 right-2.5 size-4 border-b-2 border-r-2 border-iris/80 rounded-br" />
        <CameraArt className="h-auto w-full text-flash-dim" />
        <p className="mt-3 text-center text-[11px] font-medium tracking-wide text-flash-faint">
          IMG_4032.jpg
        </p>
      </div>

      {/* scan beam */}
      <div
        data-scan
        className="absolute left-6 right-6 top-[8%] h-[3px] rounded-full bg-gradient-to-r from-transparent via-iris to-transparent shadow-[0_0_18px_2px] shadow-iris/40"
      />

      {/* ---- stage 2: attribute chips ---- */}
      <div className="absolute inset-x-5 top-[300px] flex flex-wrap justify-center gap-2">
        {CHIPS.map((chip) => (
          <span
            key={chip}
            data-chip
            className="rounded-full border border-iris/30 bg-iris/10 px-3 py-1.5 text-[11.5px] font-medium text-iris"
          >
            {chip}
          </span>
        ))}
      </div>

      {/* ---- stage 3: price ---- */}
      <div
        data-price
        className="absolute inset-x-5 bottom-5 translate-y-3 rounded-2xl border border-line/80 bg-night-2/90 px-4 py-3.5"
      >
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
              Suggested price
            </p>
            <p
              data-price-num
              className="nums font-display text-[26px] font-bold leading-tight text-flash"
            >
              $0
            </p>
          </div>
          <div className="text-right">
            <span className="rounded-full bg-iris/15 px-2.5 py-1 text-[10.5px] font-semibold text-iris">
              6 sources cited
            </span>
            <p className="mt-1.5 text-[11px] text-flash-faint">range $98–$145</p>
          </div>
        </div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-panel-2">
          <div data-range-fill className="h-full w-[72%] rounded-full bg-gradient-to-r from-iris-deep to-iris" />
        </div>
      </div>

      {/* ---- stage 4: assembled listing ---- */}
      <div
        data-listing
        className="absolute inset-x-5 top-[130px] rounded-2xl border border-line-2/70 bg-night-2 p-4 opacity-0 shadow-[0_20px_50px_-16px_rgba(0,0,0,.8)]"
      >
        <div className="flex gap-3.5">
          <div className="flex h-[74px] w-[74px] shrink-0 items-center justify-center rounded-xl border border-line bg-gradient-to-br from-panel-2 to-night p-2">
            <CameraArt className="h-auto w-full text-flash-dim" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold leading-snug text-flash">
              Canon AE-1 Program 35mm Film Camera
            </p>
            <p className="truncate text-[12px] text-flash-faint">
              w/ FD 50mm f/1.8 · good condition · tested
            </p>
            <p className="nums mt-1.5 font-display text-[20px] font-bold text-flash">
              $128
            </p>
          </div>
        </div>
        <div className="mt-3.5 flex items-center justify-between gap-3">
          <span className="rounded-full bg-iris/12 px-2.5 py-1 text-[10.5px] font-semibold text-iris">
            92% confident
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-iris px-3.5 py-1.5 text-[12px] font-bold text-iris-ink">
            Publish to eBay
          </span>
        </div>
        <div
          data-live
          className="absolute -right-2 -top-2 flex items-center gap-1.5 rounded-full border border-iris/40 bg-night px-2.5 py-1 text-[10.5px] font-bold text-iris shadow-[0_0_20px_-2px] shadow-iris/40"
        >
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-iris opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-iris" />
          </span>
          LIVE ON EBAY
        </div>
      </div>
    </div>
  );
}

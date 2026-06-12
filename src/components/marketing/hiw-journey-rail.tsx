"use client";

import { useRef } from "react";
import Image from "next/image";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/**
 * HiwJourneyRail (ui-r4-hiw) — the "three moves" overview as a connected
 * journey instead of three plain text cards. One real item (the page's
 * assigned Game Boy) travels the rail: photographed → researched → live.
 * Numbered nodes are joined by a connector line that draws on scroll
 * (gsap, once, gated behind prefers-reduced-motion); nodes stagger in.
 * Horizontal rail on lg+, vertical rail on mobile.
 */

const MOVES = [
  {
    n: "1",
    title: "Snap it",
    body: "One photo — up to four if condition matters. Barcodes and ISBNs are read automatically.",
    frame: "snap" as const,
  },
  {
    n: "2",
    title: "We research it",
    body: "Brand, model and condition identified, then priced against real comps — every number cites its sources.",
    frame: "research" as const,
  },
  {
    n: "3",
    title: "You approve it",
    body: "A ready-to-post listing for eBay, Facebook and Mercari. Edit anything, or let autopilot publish.",
    frame: "live" as const,
  },
];

/** The mini visual riding each node: the same item, one step further along. */
function NodeFrame({ frame }: { frame: (typeof MOVES)[number]["frame"] }) {
  const p = DEMO_PRODUCTS_BY_SLUG.gameboy;
  return (
    <div className="relative h-36 overflow-hidden rounded-xl border border-line bg-night-2">
      <Image
        src={p.image}
        alt={p.alt}
        fill
        sizes="(min-width: 1024px) 360px, 100vw"
        className="object-cover"
      />
      {frame === "snap" ? (
        <>
          <span aria-hidden className="absolute left-2.5 top-2.5 size-4 rounded-tl-lg border-l-2 border-t-2 border-white/90" />
          <span aria-hidden className="absolute right-2.5 top-2.5 size-4 rounded-tr-lg border-r-2 border-t-2 border-white/90" />
          <span aria-hidden className="absolute bottom-2.5 left-2.5 size-4 rounded-bl-lg border-b-2 border-l-2 border-white/90" />
          <span aria-hidden className="absolute bottom-2.5 right-2.5 size-4 rounded-br-lg border-b-2 border-r-2 border-white/90" />
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
            Photo 1 of 4
          </span>
        </>
      ) : null}
      {frame === "research" ? (
        <div className="absolute inset-x-2.5 bottom-2.5 flex flex-wrap gap-1.5">
          {["Game Boy Color", "Good · tested", "$95 · 12 comps"].map((chip) => (
            <span
              key={chip}
              className="rounded-md bg-black/55 px-2 py-1 text-[10.5px] font-semibold text-white backdrop-blur-sm"
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}
      {frame === "live" ? (
        <span className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
          Live on eBay — $95
        </span>
      ) : null}
    </div>
  );
}

export function HiwJourneyRail() {
  const ref = useRef<HTMLOListElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({
          scrollTrigger: { trigger: el, start: "top 78%", once: true },
        });
        tl.from(el.querySelectorAll("[data-rail-node]"), {
          opacity: 0,
          y: 26,
          duration: 0.7,
          ease: "power3.out",
          stagger: 0.18,
        });
        // Connector segments draw node→node, slightly behind the nodes so
        // the line appears to pull each next step into place.
        tl.from(
          el.querySelectorAll("[data-rail-seg='h']"),
          { scaleX: 0, transformOrigin: "left center", duration: 0.5, ease: "power2.inOut", stagger: 0.18 },
          0.25,
        );
        tl.from(
          el.querySelectorAll("[data-rail-seg='v']"),
          { scaleY: 0, transformOrigin: "center top", duration: 0.5, ease: "power2.inOut", stagger: 0.18 },
          0.25,
        );
      });
    },
    { scope: ref },
  );

  return (
    <ol ref={ref} className="grid gap-12 lg:grid-cols-3 lg:gap-9">
      {MOVES.map(({ n, title, body, frame }, i) => (
        <li
          key={n}
          data-rail-node
          className="relative grid grid-cols-[3rem_minmax(0,1fr)] gap-x-5 lg:block"
        >
          {/* connector to the next node — horizontal on lg+, vertical below
              (mobile content lives in its own column so the line never
              crosses text) */}
          {i < MOVES.length - 1 ? (
            <>
              <span
                aria-hidden
                data-rail-seg="h"
                className="absolute -right-9 left-16 top-6 hidden h-[2px] rounded-full bg-gradient-to-r from-iris/60 via-iris/35 to-iris/60 lg:block"
              />
              <span
                aria-hidden
                data-rail-seg="v"
                className="absolute -bottom-12 left-6 top-14 w-[2px] -translate-x-1/2 rounded-full bg-gradient-to-b from-iris/60 via-iris/35 to-iris/60 lg:hidden"
              />
            </>
          ) : null}
          <span className="relative z-10 flex size-12 items-center justify-center rounded-full border-2 border-iris/40 bg-panel shadow-card">
            <span className="nums font-display text-[18px] font-bold text-iris">{n}</span>
          </span>
          <div className="lg:mt-6">
            <NodeFrame frame={frame} />
            <h3 className="mt-5 font-display text-[21px] font-semibold tracking-tight text-flash">
              {title}
            </h3>
            <p className="mt-2.5 max-w-[44ch] text-[15px] leading-relaxed text-flash-dim">
              {body}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

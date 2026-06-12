"use client";

import { useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { HIW_GLYPHS } from "@/components/marketing/hiw-glyphs";

/**
 * HiwPipelineNav (ui-r4-hiw) — replaces the old ScrollVelocity verb marquee.
 * The five pipeline verbs become rich cards that double as page navigation:
 * each carries a live micro-preview of its step clip (mounts on hover/focus,
 * plays muted while hovered) over a designed slate, and clicking one scrolls
 * to that step's full section (#step-{id}). Horizontal snap rail on mobile,
 * five-up band on desktop. Reduced motion: static slates, instant jumps.
 */

const VERBS = [
  { id: "snap", n: "01", verb: "Snap", tagline: "1–4 photos in" },
  { id: "identify", n: "02", verb: "Identify", tagline: "Attributes extracted" },
  { id: "price", n: "03", verb: "Price", tagline: "Comps, cited" },
  { id: "write", n: "04", verb: "Write", tagline: "Native copy ×3" },
  { id: "publish", n: "05", verb: "Publish", tagline: "Live on eBay" },
] as const;

function VerbCard({
  id,
  n,
  verb,
  tagline,
  reduced,
}: (typeof VERBS)[number] & { reduced: boolean | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [warm, setWarm] = useState(false);
  const [failed, setFailed] = useState(false);

  const wake = () => {
    if (reduced) return;
    setWarm(true);
    videoRef.current?.play().catch(() => {});
  };
  const rest = () => videoRef.current?.pause();

  return (
    <button
      type="button"
      onClick={() => {
        document.getElementById(`step-${id}`)?.scrollIntoView({
          behavior: reduced ? "auto" : "smooth",
          block: "start",
        });
      }}
      onMouseEnter={wake}
      onMouseLeave={rest}
      onFocus={wake}
      onBlur={rest}
      aria-label={`Jump to the ${verb} step`}
      className="group w-56 shrink-0 snap-start rounded-2xl border border-line bg-panel p-3 text-left shadow-card transition-[transform,border-color,box-shadow] duration-300 motion-safe:hover:-translate-y-1 hover:border-iris/45 focus-visible:border-iris/45 lg:w-auto"
    >
      <span className="relative block aspect-video overflow-hidden rounded-xl bg-night-2">
        {/* designed slate — loading state and reduced-motion / 404 fallback */}
        <span
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 85% at 18% 0%, var(--tint-violet-soft), transparent 70%), radial-gradient(60% 75% at 90% 18%, var(--tint-cyan-soft), transparent 70%)",
          }}
        />
        <span className="absolute left-2.5 top-2.5 flex size-8 items-center justify-center rounded-lg bg-iris/12 text-iris [&>svg]:size-4">
          {HIW_GLYPHS[id]}
        </span>
        {warm && !failed ? (
          <video
            ref={videoRef}
            src={`/demo/steps/${id}.mp4`}
            muted
            loop
            playsInline
            preload="metadata"
            aria-hidden
            tabIndex={-1}
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        ) : null}
      </span>
      <span className="mt-3 flex items-baseline justify-between px-1">
        <span className="font-display text-[17px] font-bold tracking-tight text-flash">
          {verb}
        </span>
        <span className="nums font-display text-[12px] font-bold text-flash-faint">
          {n}
        </span>
      </span>
      <span className="mt-0.5 flex items-center justify-between px-1 pb-0.5">
        <span className="text-[12.5px] text-flash-faint">{tagline}</span>
        <span
          aria-hidden
          className="text-[13px] text-iris opacity-0 transition-[opacity,transform] duration-300 motion-safe:-translate-x-1 motion-safe:group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          ↓
        </span>
      </span>
    </button>
  );
}

export function HiwPipelineNav() {
  const reduced = useReducedMotion();
  return (
    <nav aria-label="Pipeline steps" className="mx-auto w-full max-w-7xl px-5 sm:px-8">
      <div className="-mx-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-5 lg:gap-5 lg:overflow-visible lg:px-0 lg:pb-0">
        {VERBS.map((v) => (
          <VerbCard key={v.id} {...v} reduced={reduced} />
        ))}
      </div>
    </nav>
  );
}

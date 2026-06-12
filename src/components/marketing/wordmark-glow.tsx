"use client";

/**
 * Footer wordmark with a hover-driven shimmer sweep. The gradient layers and
 * glow live in .wordmark-glow (globals.css, ui-r4-landing block); this
 * component only drives background-position from rAF while hovered.
 *
 * Why JS and not a CSS keyframe: Chrome doesn't reliably repaint
 * background-clip:text layers during background-position keyframe animation
 * (stale paint — the band freezes). Per-frame inline style updates force the
 * repaint; it's the same technique react-bits ShinyText uses.
 */

import { useEffect, useRef, useState } from "react";

/** One full left→right pass of the shine band. */
const SWEEP_MS = 2400;

export function WordmarkGlow() {
  const ref = useRef<HTMLParagraphElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!hovered || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = ((now - start) % SWEEP_MS) / SWEEP_MS;
      // p: 200% (band parked off the left edge) → -100% (off the right edge);
      // layer 2 (the resting vertical fade) stays pinned at 0 0.
      const p = 200 - progress * 300;
      el.style.backgroundPosition = `${p}% 0, 0 0`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.backgroundPosition = ""; // back to the CSS rest position
    };
  }, [hovered]);

  return (
    <div aria-hidden className="select-none overflow-hidden">
      <p
        ref={ref}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="wordmark-glow -mb-[0.23em] text-center font-display text-[clamp(96px,18vw,260px)] font-bold leading-none tracking-tight"
      >
        SnapList
      </p>
    </div>
  );
}

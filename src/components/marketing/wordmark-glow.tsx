"use client";

/**
 * Footer wordmark with a cursor-tracking flashlight (owner round 5: "my mouse
 * is like a flashlight — it lights up the spot where my mouse is"). Two
 * layers, both clipped to the glyphs:
 *
 *   - .wordmark-glow        — the dim resting vertical fade (globals.css,
 *                             ui-r4-landing block)
 *   - .wordmark-flashlight  — a bright duplicate of the word revealed through
 *                             a soft radial mask (globals.css, ui-r5-landing
 *                             block)
 *
 * This component only drives the mask position: pointermove sets a target,
 * an rAF loop lerps toward it (smooth trailing), and inline style updates
 * force Chrome to repaint the masked clipped-text layer every frame (the
 * same stale-paint workaround the old shimmer needed). On pointer leave the
 * light fades out via the CSS opacity transition. Reduced motion: the
 * listeners never arm, so the word stays at its static resting state.
 */

import { useEffect, useRef } from "react";

/** Diameter of the flashlight mask — must match mask-size in globals.css. */
const LIGHT_SIZE = 520;
/** Per-frame chase factor: how fast the light catches up to the cursor. */
const LERP = 0.16;

export function WordmarkGlow() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const light = lightRef.current;
    if (!wrap || !light) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let inside = false;
    const cur = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };

    const paint = () => {
      const pos = `${cur.x - LIGHT_SIZE / 2}px ${cur.y - LIGHT_SIZE / 2}px`;
      light.style.webkitMaskPosition = pos;
      light.style.maskPosition = pos;
    };

    const tick = () => {
      cur.x += (target.x - cur.x) * LERP;
      cur.y += (target.y - cur.y) * LERP;
      paint();
      const settled =
        Math.abs(target.x - cur.x) < 0.3 && Math.abs(target.y - cur.y) < 0.3;
      if (inside || !settled) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };

    const onMove = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      target.x = e.clientX - r.left;
      target.y = e.clientY - r.top;
      if (!inside) {
        inside = true;
        // Snap to the entry point so the light doesn't fly in from the
        // last exit position — it just fades up under the cursor.
        cur.x = target.x;
        cur.y = target.y;
        paint();
        light.classList.add("is-lit");
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const onLeave = () => {
      inside = false;
      light.classList.remove("is-lit"); // CSS fades the light out in place
    };

    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
      light.classList.remove("is-lit");
    };
  }, []);

  return (
    <div ref={wrapRef} aria-hidden className="select-none overflow-hidden">
      <p className="wordmark-glow relative -mb-[0.23em] text-center font-display text-[clamp(96px,18vw,260px)] font-bold leading-none tracking-tight">
        SnapList
        <span ref={lightRef} className="wordmark-flashlight absolute inset-0">
          SnapList
        </span>
      </p>
    </div>
  );
}

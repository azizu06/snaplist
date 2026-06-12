"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

/**
 * Magnetic pull for the primary hero CTA (issue #51): within ~80px of the
 * wrapper the child drifts toward the cursor (max 6px x / 4px y), springing
 * back elastically once the pointer exits. No-op for reduced-motion users and
 * coarse pointers (touch).
 */

const PROXIMITY = 80;
const MAX_X = 6;
const MAX_Y = 4;

export function MagneticCta({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      if (
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        !window.matchMedia("(pointer: fine)").matches
      ) {
        return;
      }

      const xTo = gsap.quickTo(el, "x", { duration: 0.3, ease: "power3.out" });
      const yTo = gsap.quickTo(el, "y", { duration: 0.3, ease: "power3.out" });

      let inRange = false;
      const release = () => {
        if (!inRange) return;
        inRange = false;
        gsap.to(el, { x: 0, y: 0, duration: 0.5, ease: "elastic.out(1, 0.45)" });
      };

      const onMove = (e: PointerEvent) => {
        const rect = el.getBoundingClientRect();
        const near =
          e.clientX > rect.left - PROXIMITY &&
          e.clientX < rect.right + PROXIMITY &&
          e.clientY > rect.top - PROXIMITY &&
          e.clientY < rect.bottom + PROXIMITY;
        if (!near) {
          release();
          return;
        }
        inRange = true;
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        xTo(gsap.utils.clamp(-MAX_X, MAX_X, (dx / (rect.width / 2 + PROXIMITY)) * MAX_X));
        yTo(gsap.utils.clamp(-MAX_Y, MAX_Y, (dy / (rect.height / 2 + PROXIMITY)) * MAX_Y));
      };

      window.addEventListener("pointermove", onMove);
      document.documentElement.addEventListener("pointerleave", release);
      return () => {
        window.removeEventListener("pointermove", onMove);
        document.documentElement.removeEventListener("pointerleave", release);
      };
    },
    { scope: ref },
  );

  // inline-block: CSS transforms don't apply to non-replaced inline boxes.
  return (
    <span ref={ref} className="inline-block">
      {children}
    </span>
  );
}

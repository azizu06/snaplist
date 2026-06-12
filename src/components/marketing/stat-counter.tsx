"use client";

import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/** Splits "~30s" / "3" / "100%" into prefix, numeric core, suffix. */
const STAT_PATTERN = /^([^\d]*)(\d+(?:\.\d+)?)(.*)$/;

/**
 * Landing stat that counts up from 0 as it scrolls into view (GSAP +
 * ScrollTrigger, same matchMedia pattern as reveal.tsx). Non-numeric
 * prefix/suffix (~, s, %) render verbatim around the counting number.
 * Under prefers-reduced-motion (or no JS) the server-rendered final
 * value simply stays put.
 */
export function StatCounter({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      const match = STAT_PATTERN.exec(value);
      if (!el || !match) return;
      const [, prefix, num, suffix] = match;
      const target = Number.parseFloat(num);
      const decimals = num.includes(".") ? num.split(".")[1].length : 0;

      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const counter = { n: 0 };
        const render = () => {
          el.textContent = `${prefix}${counter.n.toFixed(decimals)}${suffix}`;
        };
        render(); // hold at 0 so the count-up is visible on entry
        gsap.to(counter, {
          n: target,
          duration: 1.4,
          ease: "power2.out",
          onUpdate: render,
          scrollTrigger: {
            trigger: el,
            start: "top 85%",
            once: true,
          },
        });
      });
    },
    { scope: ref, dependencies: [value] },
  );

  return <span ref={ref}>{value}</span>;
}

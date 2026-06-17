"use client";

import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/**
 * Scroll-reveal wrapper (issue #49): children fade + rise as they enter the
 * viewport. `stagger` animates direct children individually (cards in a
 * grid). Honors prefers-reduced-motion via gsap.matchMedia.
 *
 * Default state is fully VISIBLE: the SSR / pre-hydration / no-JS / reduced-
 * motion render never gets an opacity:0 offset. `immediateRender: false` keeps
 * the `from` start-state off the element until the ScrollTrigger actually
 * fires, so a headless/hidden-tab render (where IntersectionObserver may never
 * fire) ships visible instead of blank. The entrance is a post-hydration
 * enhancement only.
 */
export function Reveal({
  children,
  className,
  stagger = false,
  delay = 0,
  y = 28,
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: boolean;
  delay?: number;
  y?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const targets = stagger ? Array.from(el.children) : el;
        gsap.from(targets, {
          opacity: 0,
          y,
          duration: 0.8,
          ease: "power3.out",
          delay,
          stagger: stagger ? 0.1 : 0,
          // Don't blank the content at hydration — only apply the opacity:0/y
          // start-state when the trigger fires, so the resting render is visible.
          immediateRender: false,
          scrollTrigger: {
            trigger: el,
            start: "top 82%",
            once: true,
          },
        });
      });
    },
    { scope: ref },
  );

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

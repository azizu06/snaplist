"use client";

/**
 * The two WebGL "living background" layers (react-bits LightRays + Threads,
 * both ogl). Wrapped here so marketing pages — server components — can drop
 * them in as plain JSX while everything heavy stays client-only and lazy:
 *
 * - next/dynamic ssr:false → zero bytes in the server HTML, never blocks the
 *   hero LCP text.
 * - prefers-reduced-motion → render nothing (the prism gradient / aurora CSS
 *   underneath them stands alone).
 * - The below-the-fold Threads layer only mounts once scrolled near.
 * - Both are hidden on phones (sm:block) — no WebGL canvas tax on mobile.
 */

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const LightRays = dynamic(() => import("@/components/bits/LightRays"), {
  ssr: false,
});
const Threads = dynamic(() => import("@/components/bits/Threads"), {
  ssr: false,
});

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** SSR snapshot is `true` so nothing renders until the client confirms. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );
}

/** White light shafts streaming down through the hero's prism gradient. */
export function HeroPrismRays() {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;

  return (
    <div aria-hidden className="absolute inset-0 hidden sm:block">
      <LightRays
        raysOrigin="top-center"
        raysColor="#ffffff"
        raysSpeed={1.1}
        lightSpread={1.05}
        rayLength={1.5}
        followMouse
        mouseInfluence={0.06}
        noiseAmount={0.04}
        distortion={0.03}
      />
    </div>
  );
}

const THREADS_VIOLET: [number, number, number] = [0.427, 0.29, 1];

/** Calm violet thread lines behind the final CTA band. Mounts on scroll. */
export function CtaThreads() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setInView(true);
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden opacity-70 sm:block"
    >
      {inView && !reduced && (
        <Threads
          color={THREADS_VIOLET}
          amplitude={1.2}
          distance={0.3}
          enableMouseInteraction={false}
        />
      )}
    </div>
  );
}

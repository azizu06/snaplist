"use client";

/**
 * Ambient violet SoftAurora (react-bits, ogl) behind the sign-in card —
 * same lazy/safe recipe as the marketing live backgrounds
 * (src/components/marketing/live-backgrounds.tsx):
 * - next/dynamic ssr:false → zero bytes in the server HTML.
 * - prefers-reduced-motion → render nothing (the CSS prism gradient under it
 *   stands alone).
 * - hidden on phones (sm:block) — no WebGL canvas tax on mobile.
 */

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

const SoftAurora = dynamic(() => import("@/components/bits/SoftAurora"), {
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

export function LoginAurora() {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 hidden opacity-60 sm:block"
    >
      <SoftAurora
        color1="#6d4aff"
        color2="#9d7bff"
        brightness={0.55}
        speed={0.4}
        bandHeight={0.62}
        enableMouseInteraction={false}
      />
    </div>
  );
}

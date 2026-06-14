"use client";

/**
 * True WebGL Aurora (react-bits, ogl) behind the sign-in card — app-surfaces
 * v3 replaces the SoftAurora band with the real aurora curtain, theme-tuned:
 * - useTheme().resolvedTheme drives the color stops (light: prism violet on
 *   the white canvas; dark: the +luminosity violet so it carries on navy).
 * - next/dynamic ssr:false → zero bytes in the server HTML.
 * - prefers-reduced-motion → render nothing; the static CSS prism gradient
 *   in the (auth) layout is the designed fallback and stands alone.
 * - mobile (<sm) → same CSS fallback; no WebGL canvas tax on phones.
 */

import dynamic from "next/dynamic";
import { useCallback, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

const Aurora = dynamic(() => import("@/components/bits/Aurora"), {
  ssr: false,
});

/** Live media-query hook; `serverFallback` is the SSR/first-paint snapshot. */
function useMediaQuery(query: string, serverFallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverFallback,
  );
}

/* Theme-tuned stops. Light digs the violet DEEPER than the prism wash so the
 * curtain reads as light through it (additive violet on white disappears);
 * dark lifts the violet (+luminosity, same hue family as --color-iris dark)
 * and lets the cyan edge ring so the ridge stays crisp on navy. */
const LIGHT_STOPS = ["#5a36f0", "#7b61ff", "#38bdf8"];
const DARK_STOPS = ["#5227ff", "#7e5fff", "#22d3ee"];

export function LoginAurora() {
  // SSR snapshot `true` → nothing renders until the client confirms.
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)", true);
  // SSR snapshot `false` → mobile never pays for a WebGL context it hides.
  const desktop = useMediaQuery("(min-width: 640px)", false);
  const { resolvedTheme } = useTheme();

  if (reduced || !desktop) return null;
  const dark = resolvedTheme === "dark";

  return (
    <div
      aria-hidden
      // Full-height curtain (was 72vh) so the aurora drapes the whole screen,
      // not just the top band. A soft bottom mask dissolves the WebGL canvas
      // into the page — without it the shader would stop on a hard horizon line.
      style={{
        WebkitMaskImage:
          "linear-gradient(to bottom, black 0%, black 45%, transparent 92%)",
        maskImage:
          "linear-gradient(to bottom, black 0%, black 45%, transparent 92%)",
      }}
      className={`pointer-events-none absolute inset-x-0 top-0 h-screen ${
        dark ? "opacity-100" : "opacity-45"
      }`}
    >
      <Aurora
        colorStops={dark ? DARK_STOPS : LIGHT_STOPS}
        amplitude={1.2}
        blend={0.45}
        speed={0.7}
      />
    </div>
  );
}

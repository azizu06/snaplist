"use client";

/**
 * The WebGL "living background" layers (react-bits Prism + Iridescence, both
 * ogl). Wrapped here so marketing pages — server components — can drop them
 * in as plain JSX while everything heavy stays client-only and lazy:
 *
 * - next/dynamic ssr:false → zero bytes in the server HTML, never blocks the
 *   hero LCP text.
 * - prefers-reduced-motion → render nothing (the prism gradient / aurora CSS
 *   underneath them stands alone as the static fallback).
 * - The below-the-fold Iridescence layer only mounts once scrolled near, and
 *   Prism suspends its RAF loop offscreen.
 * - Both are hidden under 768px (md:block) — no WebGL canvas tax on mobile;
 *   the CSS gradients carry the section alone there too.
 */

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

const Prism = dynamic(() => import("@/components/bits/Prism"), {
  ssr: false,
});
const Iridescence = dynamic(() => import("@/components/bits/Iridescence"), {
  ssr: false,
});

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeMediaQuery(query: string, onChange: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const subscribeReducedMotion = (onChange: () => void) =>
  subscribeMediaQuery(REDUCED_MOTION_QUERY, onChange);
const subscribeDesktop = (onChange: () => void) =>
  subscribeMediaQuery(DESKTOP_QUERY, onChange);

/** SSR snapshot is `true` so nothing renders until the client confirms. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );
}

/** Mount gate, not just a CSS hide: a display:none WebGL canvas still boots
 *  a GL context on phones. SSR snapshot `false` → mobile never pays it. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

/** r6/r7 (load jank): hold the Prism mount until AFTER the page `load` event,
 *  THEN until the browser is idle. The GL context + ~100-step shader compile is
 *  a heavy main-thread/GPU stall; on a fast desktop `requestIdleCallback` alone
 *  fired mid-load, so the compile thrashed against the headline entrance +
 *  hydration and made the hero "jitter". Waiting for `load` first moves the
 *  compile entirely out of the entrance window. The static CSS prism gradient
 *  carries the hero for that beat and the canvas fades in over it
 *  (see .prism-canvas-enter). setReady runs only inside callbacks (never sync
 *  in the effect body), satisfying the repo's set-state-in-effect lint. */
function useIdleMounted(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (w.requestIdleCallback) {
        idleId = w.requestIdleCallback(() => setReady(true), { timeout: 1200 });
      } else {
        timeoutId = setTimeout(() => setReady(true), 300);
      }
    };
    const cancel = () => {
      if (idleId != null && w.cancelIdleCallback) w.cancelIdleCallback(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
    if (document.readyState === "complete") {
      arm();
    } else {
      window.addEventListener("load", arm, { once: true });
    }
    return () => {
      window.removeEventListener("load", arm);
      cancel();
    };
  }, []);
  return ready;
}

/**
 * The Prism shader behind the hero headline — the brand identity made
 * literal. One canvas only (it replaced the earlier LightRays layer; two
 * stacked WebGL contexts in the hero janked scroll). Tuned per theme:
 * subtle and glassy over the pastel light slab, glowing out of the navy
 * dark slab. resolvedTheme is undefined until next-themes mounts; default
 * to light (matches defaultTheme="light") and re-render on flip — Prism
 * rebuilds its program when props change.
 */
export function HeroPrism() {
  const reduced = usePrefersReducedMotion();
  const desktop = useIsDesktop();
  const idle = useIdleMounted();
  const { resolvedTheme } = useTheme();
  if (reduced || !desktop || !idle) return null;
  const dark = resolvedTheme === "dark";

  return (
    <div
      aria-hidden
      className="prism-canvas-enter pointer-events-none absolute inset-x-0 top-0 hidden h-[600px] opacity-[0.72] sm:h-[740px] md:block dark:opacity-[0.82]"
    >
      <Prism
        animationType="rotate"
        timeScale={0.35}
        // r6 (owner, take 2): the previous round shrank the prism and lifted
        // its core to y:300 to keep the bright base off the paragraph — but
        // that exiled the whole body to the top edge, where it read as a
        // faint cropped artifact, not the brand made literal. Now it's back
        // to a full, centred, brighter presence; the hero text is protected
        // by the slab-matched .hero-text-scrim veil instead (same trick the
        // CTA Iridescence uses), so we get the wow without washing out copy.
        height={3.5}
        baseWidth={5.6}
        scale={3.5}
        offset={{ x: 0, y: 70 }}
        glow={dark ? 0.9 : 0.95}
        bloom={dark ? 0.95 : 1.05}
        noise={dark ? 0.06 : 0.03}
        hueShift={dark ? 0.25 : 0.12}
        colorFrequency={1.1}
        suspendWhenOffscreen
        transparent
        // Decorative soft glow — cap the raymarched shader at 1.5x so retina
        // displays don't pay 4x the fragment cost (perf: owner felt the home
        // page render lag). Suspends entirely once scrolled past.
        maxDpr={1.5}
      />
    </div>
  );
}

/** Violet-white pastel — reads glassy on the white canvas. */
const IRIDESCENCE_LIGHT: [number, number, number] = [0.93, 0.91, 1];
/** Capped deep violet — a glow, not a glare, on the navy canvas. */
const IRIDESCENCE_DARK: [number, number, number] = [0.38, 0.31, 0.86];

/**
 * Violet iridescent field behind the final CTA band. Mounts on scroll-near
 * only. The shader canvas is opaque, so two veil layers blend it back into
 * the page: edge gradients fade into the canvas color and a center wash
 * keeps the headline contrast-safe in both themes.
 */
export function CtaIridescence() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const reduced = usePrefersReducedMotion();
  const desktop = useIsDesktop();
  const { resolvedTheme } = useTheme();

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
      className="pointer-events-none absolute inset-0 hidden md:block"
    >
      {inView && !reduced && desktop && (
        <>
          <Iridescence
            color={
              resolvedTheme === "dark" ? IRIDESCENCE_DARK : IRIDESCENCE_LIGHT
            }
            speed={0.5}
            amplitude={0.08}
            mouseReact={false}
          />
          {/* Edge blend: the band dissolves into the sections around it. */}
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,var(--color-night)_0%,transparent_28%,transparent_72%,var(--color-night)_100%)]" />
          {/* Center wash: guaranteed headline contrast over the shader. */}
          <div className="absolute inset-0 bg-night/50 dark:bg-night/45" />
        </>
      )}
    </div>
  );
}

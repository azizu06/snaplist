"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { useReducedMotion } from "motion/react";

/** "/foo.mp4" -> "/foo-dark.mp4" (the dark render lives beside the light one). */
function darkVariant(src: string) {
  return src.replace(/\.mp4$/, "-dark.mp4");
}

type Theme = "light" | "dark";

/**
 * SeamlessThemeVideo — a theme-aware demo clip that recolors IN PLACE on a
 * light/dark toggle instead of restarting.
 *
 * Why it can: the light and dark renders are the same Remotion composition, so
 * frame N is pixel-identical except for colour. Two <video>s are stacked (one
 * per theme); on a toggle we seek the incoming one to the outgoing one's
 * `currentTime` and crossfade — the scene continues from the same frame, just
 * recoloured. No reload, no jump to 0.
 *
 * Performance is preserved at the same time:
 * - Only the ACTIVE theme's clip is fetched on the critical path, and only once
 *   the theme is known (`resolvedTheme != null`), so a dark visitor never pulls
 *   the light file first. The opposite theme is preloaded on
 *   requestIdleCallback — off the critical path — so the first toggle is
 *   instant without costing initial load.
 * - At rest exactly one decoder runs: the off-theme video is paused (no decode)
 *   and only wakes for the crossfade, after which the outgoing one is paused.
 * - Mounting is deferred one frame past first paint; below-the-fold instances
 *   are gated on an IntersectionObserver and paused when scrolled away.
 * - prefers-reduced-motion: no video plays; the `children` poster stands alone.
 *
 * `children` render behind both videos as the poster / loading / 404 fallback,
 * so a still-rendering or missing clip degrades to an intentional still.
 */
export function SeamlessThemeVideo({
  src,
  label,
  className,
  videoClassName = "object-cover",
  fadeMs = 320,
  lazy = false,
  rootMargin = "240px 0px",
  children,
}: {
  /** Light-theme clip; the dark sibling is `<name>-dark.mp4`. */
  src: string;
  label: string;
  /** Classes for the relative container (set the aspect ratio + clipping here). */
  className?: string;
  /** Classes for each stacked <video> (defaults to object-cover). */
  videoClassName?: string;
  /** Crossfade / fade-in duration in ms. */
  fadeMs?: number;
  /** Defer mounting until scrolled near (below-the-fold instances). */
  lazy?: boolean;
  rootMargin?: string;
  /** Poster / fallback, rendered behind the videos (position it yourself). */
  children?: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const reduced = useReducedMotion();
  const darkSrc = darkVariant(src);

  const rootRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLVideoElement>(null);
  const darkRef = useRef<HTMLVideoElement>(null);
  const prevActive = useRef<Theme | null>(null);

  const [mounted, setMounted] = useState(false);
  const [near, setNear] = useState(!lazy);
  const [visible, setVisible] = useState(!lazy);
  const [idlePreloaded, setIdlePreloaded] = useState(false);
  const [shownLight, setShownLight] = useState(false);
  const [shownDark, setShownDark] = useState(false);
  const [failedLight, setFailedLight] = useState(false);
  const [failedDark, setFailedDark] = useState(false);
  // The theme held at opacity 1. Flipped in onPlaying (an event, not an effect)
  // once the incoming video is actually playing, so the crossfade never reveals
  // the poster mid-swap and a toggle-back shows the freshly re-synced frame.
  const [displayed, setDisplayed] = useState<Theme>("light");

  const active: Theme = resolvedTheme === "dark" ? "dark" : "light";
  // resolvedTheme is undefined until next-themes mounts; wait for it so the
  // first fetch is always the correct theme (no light-then-dark double load).
  const themeReady = mounted && near && !reduced && resolvedTheme != null;

  // Attachment is DERIVED, not an effect: the active theme attaches as soon as
  // the slot is ready (the single critical-path fetch); the opposite attaches
  // once idle-preloaded. Unattached videos carry no src and fetch nothing.
  const attachLight = themeReady && (active === "light" || idlePreloaded);
  const attachDark = themeReady && (active === "dark" || idlePreloaded);

  // Defer one frame past first paint (rAF, not a bare setState, to satisfy
  // react-hooks/set-state-in-effect) so the videos never block the hero render.
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Lazy instances: mount when near the viewport, and play only while ~visible.
  useEffect(() => {
    if (!lazy) return;
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setNear(true);
        setVisible(entry.intersectionRatio >= 0.35);
      },
      { rootMargin, threshold: [0, 0.35] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, rootMargin]);

  // Preload the OPPOSITE theme on idle so the first toggle is instant, but off
  // the critical path (setState runs inside the idle callback — never sync).
  useEffect(() => {
    if (!themeReady) return;
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const schedule = w.requestIdleCallback
      ? (cb: () => void) => w.requestIdleCallback!(cb, { timeout: 2500 })
      : (cb: () => void) => window.setTimeout(cb, 1800);
    const cancel = w.cancelIdleCallback ?? window.clearTimeout;
    const id = schedule(() => setIdlePreloaded(true));
    return () => cancel(id);
  }, [themeReady]);

  // Drive playback: play the active video — continuing from the outgoing one's
  // position on a toggle (no restart) — and pause everything when out of view.
  useEffect(() => {
    if (!themeReady) return;
    if (!visible) {
      lightRef.current?.pause();
      darkRef.current?.pause();
      return;
    }
    const a = (active === "dark" ? darkRef : lightRef).current;
    if (!a) return;

    const justToggled = prevActive.current != null && prevActive.current !== active;
    prevActive.current = active;

    if (justToggled) {
      const out = (active === "dark" ? lightRef : darkRef).current;
      const t = out?.currentTime;
      const go = () => {
        try {
          if (t != null && Number.isFinite(t)) a.currentTime = t;
        } catch {
          /* seeking before metadata can throw; play() below still recovers */
        }
        void a.play().catch(() => {});
      };
      if (a.readyState >= 1 /* HAVE_METADATA */) go();
      else a.addEventListener("loadedmetadata", go, { once: true });
    } else {
      void a.play().catch(() => {});
    }
  }, [themeReady, visible, active, idlePreloaded]);

  // After the crossfade lands, pause the now-hidden video to free its decoder.
  useEffect(() => {
    const offRef = displayed === "dark" ? lightRef : darkRef;
    const id = window.setTimeout(() => {
      try {
        offRef.current?.pause();
      } catch {
        /* no-op */
      }
    }, fadeMs + 40);
    return () => window.clearTimeout(id);
  }, [displayed, fadeMs]);

  const lightOn = displayed === "light" && shownLight && !failedLight;
  const darkOn = displayed === "dark" && shownDark && !failedDark;
  const fade = { transitionDuration: `${fadeMs}ms` };

  return (
    <div ref={rootRef} className={`relative overflow-hidden ${className ?? ""}`}>
      {children}
      <video
        ref={lightRef}
        src={attachLight ? src : undefined}
        preload={attachLight ? "auto" : "none"}
        muted
        loop
        playsInline
        aria-label={label}
        onPlaying={() => {
          setShownLight(true);
          if (active === "light") setDisplayed("light");
        }}
        onError={() => setFailedLight(true)}
        style={fade}
        className={`absolute inset-0 h-full w-full transition-opacity ${videoClassName} ${
          lightOn ? "opacity-100" : "opacity-0"
        }`}
      />
      <video
        ref={darkRef}
        src={attachDark ? darkSrc : undefined}
        preload={attachDark ? "auto" : "none"}
        muted
        loop
        playsInline
        aria-hidden
        onPlaying={() => {
          setShownDark(true);
          if (active === "dark") setDisplayed("dark");
        }}
        onError={() => setFailedDark(true)}
        style={fade}
        className={`absolute inset-0 h-full w-full transition-opacity ${videoClassName} ${
          darkOn ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}

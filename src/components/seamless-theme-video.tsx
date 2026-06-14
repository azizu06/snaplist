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
 * SeamlessThemeVideo — a theme-aware demo clip that recolors IN PLACE and
 * (near-)INSTANTLY on a light/dark toggle, matching the page background.
 *
 * Why it can: the light and dark renders are the same Remotion composition, so
 * frame N is pixel-identical except colour. Two <video>s are stacked (one per
 * theme) and BOTH play in lockstep while on screen — same duration, same rate,
 * so they stay frame-aligned. A toggle is then a pure opacity crossfade with
 * NO seek, so the recolour starts on the next frame (~instant) instead of
 * waiting ~1.4s for a paused video to seek+decode to the current timestamp.
 *
 * Performance is preserved:
 * - Only the ACTIVE theme's clip is fetched on the critical path, and only once
 *   the theme is known (`resolvedTheme != null`) so a dark visitor never pulls
 *   the light file first. The opposite preloads on requestIdleCallback — off
 *   the critical path — then starts playing muted at opacity 0, synced once to
 *   the active clip (that single seek is hidden inside idle time).
 * - Both decoders run only WHILE THE CLIP IS ON SCREEN; below-the-fold
 *   instances stay paused (IntersectionObserver) and pause again when scrolled
 *   away, so there is no steady-state cost when you are not looking at it.
 * - Mounting is deferred one frame past first paint. prefers-reduced-motion:
 *   nothing plays; the `children` poster stands alone.
 *
 * `children` render behind both videos as the poster / loading / 404 fallback.
 */
export function SeamlessThemeVideo({
  src,
  label,
  className,
  videoClassName = "object-cover",
  fadeMs = 140,
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
  /** Crossfade / fade-in duration in ms (kept short so a toggle feels instant). */
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

  const [mounted, setMounted] = useState(false);
  const [near, setNear] = useState(!lazy);
  const [visible, setVisible] = useState(!lazy);
  const [idlePreloaded, setIdlePreloaded] = useState(false);
  const [shownLight, setShownLight] = useState(false);
  const [shownDark, setShownDark] = useState(false);
  const [failedLight, setFailedLight] = useState(false);
  const [failedDark, setFailedDark] = useState(false);

  const active: Theme = resolvedTheme === "dark" ? "dark" : "light";
  // resolvedTheme is undefined until next-themes mounts; wait for it so the
  // first fetch is always the correct theme (no light-then-dark double load).
  const themeReady = mounted && near && !reduced && resolvedTheme != null;

  // Attachment is DERIVED: the active theme attaches as soon as the slot is
  // ready (single critical-path fetch); the opposite once idle-preloaded.
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

  // Preload the OPPOSITE theme on idle so the toggle is instant, but off the
  // critical path (setState runs inside the idle callback — never sync).
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

  // Drive playback: keep BOTH videos playing in lockstep while visible (so a
  // toggle is a pure opacity swap, no seek), pause both when out of view. The
  // off-theme clip is synced to the active one's time once it joins; the only
  // slow seek happens here, while it is still hidden (opacity 0).
  useEffect(() => {
    if (!themeReady) return;
    const light = lightRef.current;
    const dark = darkRef.current;
    if (!visible) {
      light?.pause();
      dark?.pause();
      return;
    }
    const activeEl = active === "dark" ? dark : light;
    const otherEl = active === "dark" ? light : dark;
    const otherAttached = active === "dark" ? attachLight : attachDark;
    if (activeEl) void activeEl.play().catch(() => {});
    if (otherEl && otherAttached) {
      const at = activeEl?.currentTime;
      // Re-align the hidden clip if it has drifted (invisible seek), then keep
      // it running so the next toggle is instant.
      if (at != null && Number.isFinite(at) && Math.abs(otherEl.currentTime - at) > 0.3) {
        try {
          otherEl.currentTime = at;
        } catch {
          /* seeking before metadata can throw; play() still recovers */
        }
      }
      void otherEl.play().catch(() => {});
    }
  }, [themeReady, visible, active, idlePreloaded, attachLight, attachDark]);

  // The crossfade is driven by the `.dark` CLASS, not React state — next-themes
  // flips that class synchronously (the same thing that recolours the page
  // background instantly), so the video swap starts on the very next frame
  // instead of waiting for `resolvedTheme` to propagate through the React tree
  // (which on a heavy page can lag ~0.7s). Both clips already play in lockstep,
  // so the incoming one is showing the correct, aligned frame the instant it
  // becomes visible. The `shown` gate keeps a clip hidden until it has produced
  // a frame, so the initial reveal still fades up from the poster.
  const lightOpacity =
    shownLight && !failedLight ? "opacity-100 dark:opacity-0" : "opacity-0";
  const darkOpacity =
    shownDark && !failedDark ? "opacity-0 dark:opacity-100" : "opacity-0";
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
        onPlaying={() => setShownLight(true)}
        onError={() => setFailedLight(true)}
        style={fade}
        className={`absolute inset-0 h-full w-full transition-opacity ${videoClassName} ${lightOpacity}`}
      />
      <video
        ref={darkRef}
        src={attachDark ? darkSrc : undefined}
        preload={attachDark ? "auto" : "none"}
        muted
        loop
        playsInline
        aria-hidden
        onPlaying={() => setShownDark(true)}
        onError={() => setFailedDark(true)}
        style={fade}
        className={`absolute inset-0 h-full w-full transition-opacity ${videoClassName} ${darkOpacity}`}
      />
    </div>
  );
}

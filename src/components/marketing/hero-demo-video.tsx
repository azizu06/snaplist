"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { useThemedVideoSrc } from "@/lib/use-themed-video-src";

/**
 * The landing hero's demo clip, as a client island so it can follow the app
 * theme (the dark render + its dark poster swap in when the theme is dark).
 *
 * Load-cost guarantees (the hero is above the fold, so this matters):
 * - The <video> ships with NO src and preload="none" in the server HTML, so
 *   the browser fetches ZERO video bytes during the initial paint — the
 *   poster image carries the slot. The headline/poster own the LCP; the
 *   clip never competes for bandwidth on the critical path.
 * - The real src is attached one frame after mount (requestAnimationFrame),
 *   by which point next-themes has resolved the theme. A dark visitor fetches
 *   ONLY hero-demo-dark.mp4 — never the light file first, then the dark one.
 * - `load()` runs once when the src is first attached (the single fetch) and
 *   again only on a real theme toggle, never redundantly on mount.
 */
export function HeroDemoVideo() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { resolvedTheme } = useTheme();
  const src = useThemedVideoSrc("/hero-demo.mp4");
  // SSR + first client render: false (identical markup, no hydration
  // mismatch). Flipped after the first paint so the video never blocks it.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // rAF (not a bare setState) defers the mount past first paint and keeps
    // react-hooks/set-state-in-effect happy.
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // The browser fetches the clip exactly once: setting the `src` attribute (on
  // the ready flip) runs the resource-selection algorithm by itself, and
  // `autoPlay` starts it — so NO manual `load()` here (that would double-fetch).
  // On a later theme toggle the changed `src` auto-reloads; we only nudge
  // play() so it resumes. The first attach is skipped entirely.
  const attached = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) return;
    if (!attached.current) {
      attached.current = true;
      return;
    }
    void video.play().catch(() => {});
  }, [src, ready]);

  const poster =
    resolvedTheme === "dark"
      ? "/hero-demo-poster-dark.jpg"
      : "/hero-demo-poster.jpg";

  return (
    <video
      ref={videoRef}
      // No src / preload="none" until ready → zero video bytes on first paint.
      src={ready ? src : undefined}
      poster={poster}
      preload={ready ? "auto" : "none"}
      autoPlay
      muted
      loop
      playsInline
      className="block h-auto w-full rounded-2xl border border-line bg-white shadow-[0_24px_64px_-24px_rgba(19,30,58,0.35),0_4px_16px_-6px_rgba(19,30,58,0.12)] dark:border-2 dark:border-white/20 dark:shadow-[0_0_0_1px_rgba(126,95,255,0.25),0_0_60px_-10px_rgba(126,95,255,0.35),0_24px_64px_-24px_rgba(0,0,0,0.7)]"
      aria-label="Demo: a photo becomes a priced, published eBay listing"
    />
  );
}

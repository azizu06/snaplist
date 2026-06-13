"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { useThemedVideoSrc } from "@/lib/use-themed-video-src";

/**
 * The landing hero's demo clip, as a client island so it can follow the app
 * theme: the dark render (`/hero-demo-dark.mp4` + its first-frame poster) is
 * swapped in when the theme is dark, and the element reloads on a toggle so
 * the new file actually plays. The chrome (border, glow, radius) is unchanged
 * from the original inline <video>.
 */
export function HeroDemoVideo() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { resolvedTheme } = useTheme();
  const src = useThemedVideoSrc("/hero-demo.mp4");
  const poster =
    resolvedTheme === "dark"
      ? "/hero-demo-poster-dark.jpg"
      : "/hero-demo-poster.jpg";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.load();
    video.play().catch(() => {});
  }, [src]);

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      className="block h-auto w-full rounded-2xl border border-line bg-white shadow-[0_24px_64px_-24px_rgba(19,30,58,0.35),0_4px_16px_-6px_rgba(19,30,58,0.12)] dark:border-2 dark:border-white/20 dark:shadow-[0_0_0_1px_rgba(126,95,255,0.25),0_0_60px_-10px_rgba(126,95,255,0.35),0_24px_64px_-24px_rgba(0,0,0,0.7)]"
      aria-label="Demo: a photo becomes a priced, published eBay listing"
    />
  );
}

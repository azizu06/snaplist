"use client";

import { SeamlessThemeVideo } from "@/components/seamless-theme-video";

/**
 * The landing hero's demo clip. SeamlessThemeVideo handles the theme-aware
 * sources (dark render swapped in on dark, recoloured in place on a toggle —
 * no restart) and the load discipline (only the active theme is fetched on the
 * critical path; the other preloads on idle).
 *
 * The poster is a CSS background with a `dark:` variant rather than a JS-chosen
 * <video poster>, so it is theme-correct from the very first paint (next-themes
 * sets the `dark` class before paint) — no light-poster flash for dark
 * visitors — and it carries the slot until the clip fades in. aspect-video
 * reserves the 16:9 box up front, so there is no layout shift (CLS stays 0).
 */
export function HeroDemoVideo() {
  return (
    <SeamlessThemeVideo
      src="/hero-demo.mp4"
      label="Demo: a photo becomes a priced, published eBay listing"
      className="aspect-video rounded-2xl border border-line bg-white shadow-[0_24px_64px_-24px_rgba(19,30,58,0.35),0_4px_16px_-6px_rgba(19,30,58,0.12)] dark:border-2 dark:border-white/20 dark:shadow-[0_0_0_1px_rgba(126,95,255,0.25),0_0_60px_-10px_rgba(126,95,255,0.35),0_24px_64px_-24px_rgba(0,0,0,0.7)]"
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-[url('/hero-demo-poster.jpg')] bg-cover bg-center dark:bg-[url('/hero-demo-poster-dark.jpg')]"
      />
    </SeamlessThemeVideo>
  );
}

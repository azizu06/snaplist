"use client";

import { SeamlessThemeVideo } from "@/components/seamless-theme-video";
import { RealUiCapturePoster } from "@/components/real-ui-capture-poster";

/**
 * "Watch how replies work" teaser inside the inbox empty state.
 *
 * The real inbox list, draft, and sent states run through
 * SeamlessThemeVideo inside a mini app-window frame: it lazy-mounts on scroll,
 * swaps in the dark render on dark mode and recolours in place on a toggle (no
 * restart), and only ever fetches the active theme on the critical path. A real
 * inbox capture is its loading, error, and reduced-motion fallback.
 */

export function InboxDemoVideo() {
  return (
    /* Full panel width (round 5): the 1920×1080 clip was capped at max-w-md
       and its on-screen text was illegible. px-4 keeps a slim inset inside
       the empty-state card; the video now spans the whole panel. */
    <figure className="mt-8 w-full px-4 pb-4 text-left sm:px-5 sm:pb-5">
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-md">
        {/* mini app-window chrome so the teaser reads as a product moment */}
        <div className="flex items-center gap-1.5 border-b border-border bg-surface-2/70 px-3.5 py-2.5">
          <span aria-hidden className="size-2.5 rounded-full bg-border-strong" />
          <span aria-hidden className="size-2.5 rounded-full bg-border-strong" />
          <span aria-hidden className="size-2.5 rounded-full bg-border-strong" />
          <span className="ml-2 flex items-center gap-1.5 text-[14px] font-semibold text-fg">
            <span aria-hidden className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
            Watch how replies work
          </span>
        </div>
        <SeamlessThemeVideo
          src="/demo/inbox-qa.mp4"
          mobileSrc="/demo/inbox-qa-mobile.mp4"
          label="Demo: a buyer question answered with a drafted reply"
          lazy
          rootMargin="160px"
          className="aspect-[4/5] md:aspect-video"
        >
          <RealUiCapturePoster
            shot="inbox-draft"
            label="SnapList inbox with a buyer reply drafted for approval"
          />
        </SeamlessThemeVideo>
      </div>
      <figcaption className="mt-2.5 text-center text-[15px] leading-relaxed text-muted">
        A buyer asks · the agent drafts from your listing · you approve &amp; send.
      </figcaption>
    </figure>
  );
}

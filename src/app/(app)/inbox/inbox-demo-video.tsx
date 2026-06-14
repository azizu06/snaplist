"use client";

import { SeamlessThemeVideo } from "@/components/seamless-theme-video";

/**
 * "Watch how replies work" teaser inside the inbox empty state.
 *
 * Uses /demo/inbox-qa.mp4 — a buyer-Q&A clip on a DIFFERENT item (brass chess
 * set) than the marketing tour's step 6 (Canon AE-1), so a logged-in user who
 * already watched the tour sees a fresh scenario here, not a repeat.
 *
 * The clip (/demo/inbox-qa.mp4, 1920×1080 muted loop) runs through
 * SeamlessThemeVideo inside a mini app-window frame: it lazy-mounts on scroll,
 * swaps in the dark render on dark mode and recolours in place on a toggle (no
 * restart), and only ever fetches the active theme on the critical path. The
 * designed CSS poster (a paused buyer→draft exchange) is its fallback — it
 * holds the slot until the clip plays, degrades a missing/still-rendering mp4
 * to an intentional still, and stands alone under prefers-reduced-motion.
 */

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5c.3 0 .57.2.66.49l1.4 4.6a3 3 0 0 0 1.99 1.99l4.6 1.4a.69.69 0 0 1 0 1.32l-4.6 1.4a3 3 0 0 0-1.99 1.99l-1.4 4.6a.69.69 0 0 1-1.32 0l-1.4-4.6a3 3 0 0 0-1.99-1.99l-4.6-1.4a.69.69 0 0 1 0-1.32l4.6-1.4a3 3 0 0 0 1.99-1.99l1.4-4.6c.09-.29.36-.49.66-.49Z" />
    </svg>
  );
}

/** The designed poster: a paused frame of the exchange the video shows. */
function PosterScene() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex flex-col justify-center gap-1.5 bg-surface-2 px-5 py-3 sm:gap-2.5 sm:px-10 sm:py-5"
    >
      {/* soft violet pool, echoes the empty-state bloom */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 90% at 50% 0%, rgba(109, 74, 255, 0.12), transparent 70%)",
        }}
      />
      <div className="relative max-w-[62%] rounded-2xl rounded-bl-md border border-border bg-surface px-3.5 py-2 shadow-xs sm:py-2.5">
        <p className="text-[10px] font-semibold text-faint sm:text-[12px]">
          buyer · via eBay
        </p>
        <p className="mt-0.5 text-[13.5px] leading-snug text-fg sm:text-[15px]">
          Is this still available? Any scratches?
        </p>
      </div>
      <div className="relative ml-auto max-w-[68%] rounded-2xl rounded-br-md border border-accent/25 bg-accent-soft/70 px-3.5 py-2 shadow-xs sm:py-2.5">
        <p className="flex items-center gap-1 text-[10px] font-semibold text-accent-soft-fg sm:text-[12px]">
          <SparkleIcon className="size-3" />
          reply drafted in seconds
        </p>
        <p className="mt-0.5 text-[13.5px] leading-snug text-fg sm:text-[15px]">
          Yes, it&apos;s available, light wear only, photos show every angle.
        </p>
      </div>
      <p className="relative mx-auto inline-flex items-center gap-1.5 rounded-full bg-[#131e3a]/70 px-3.5 py-1.5 text-[11px] font-semibold text-white sm:mt-1 sm:text-[13.5px]">
        <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
        </svg>
        Approve &amp; send
      </p>
    </div>
  );
}

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
          label="Demo: a buyer question answered with a drafted reply"
          lazy
          rootMargin="160px"
          className="aspect-video"
        >
          <PosterScene />
        </SeamlessThemeVideo>
      </div>
      <figcaption className="mt-2.5 text-center text-[15px] leading-relaxed text-muted">
        A buyer asks · the agent drafts from your listing · you approve &amp; send.
      </figcaption>
    </figure>
  );
}

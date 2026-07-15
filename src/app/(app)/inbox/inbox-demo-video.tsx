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
export const INBOX_EMPTY_DEMO = {
  src: "/demo/inbox-qa-mobile.mp4",
  formFactor: "mobile",
} as const;

export function InboxDemoVideo() {
  return (
    <figure data-inbox-demo className="mt-8 w-full px-4 pb-4 text-left sm:px-5 sm:pb-5">
      <div data-inbox-demo-frame className="mx-auto w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-surface shadow-md">
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
          src={INBOX_EMPTY_DEMO.src}
          label="Demo: a buyer asks a question, SnapList drafts a reply, and the seller chooses whether to send it"
          lazy
          rootMargin="160px"
          className="aspect-[6/5]"
        >
          <RealUiCapturePoster
            shot="inbox-draft"
            formFactor={INBOX_EMPTY_DEMO.formFactor}
            label="SnapList inbox with a buyer reply drafted for approval"
          />
        </SeamlessThemeVideo>
      </div>
      <figcaption className="mt-2.5 text-center text-[15px] leading-relaxed text-muted">
        See the buyer&apos;s question, a draft tied to the listing, and the moment you choose whether to send it.
      </figcaption>
    </figure>
  );
}

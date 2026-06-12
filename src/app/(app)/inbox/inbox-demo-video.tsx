"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * "Watch how replies work" teaser inside the inbox empty state.
 *
 * Plays /demo/buyer-qa.mp4 (1920×1080 muted loop) inside a mini app-window
 * frame, with three guards so it always reads as designed:
 * - lazy: the <video> element only mounts once the frame scrolls into view
 *   (IntersectionObserver), and autoplays muted/loop/playsInline from there;
 * - a fully designed CSS poster (a paused buyer→draft exchange) sits under
 *   the video and stays up until the first frame can actually play — so a
 *   missing/still-rendering mp4 degrades to an intentional illustration,
 *   never a broken player;
 * - prefers-reduced-motion: the video never mounts; the poster stands alone.
 */

function useReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
}

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
      <div className="relative max-w-[62%] rounded-2xl rounded-bl-md border border-border bg-surface px-3 py-1.5 shadow-xs sm:py-2">
        <p className="text-[9px] font-semibold text-faint sm:text-[9.5px]">
          buyer · via eBay
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-fg sm:text-[12px]">
          Is this still available? Any scratches?
        </p>
      </div>
      <div className="relative ml-auto max-w-[68%] rounded-2xl rounded-br-md border border-accent/25 bg-accent-soft/70 px-3 py-1.5 shadow-xs sm:py-2">
        <p className="flex items-center gap-1 text-[9px] font-semibold text-accent-soft-fg sm:text-[9.5px]">
          <SparkleIcon className="size-2.5" />
          reply drafted in seconds
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-fg sm:text-[12px]">
          Yes, it&apos;s available — light wear only, photos show every angle.
        </p>
      </div>
      <p className="relative mx-auto inline-flex items-center gap-1.5 rounded-full bg-[#131e3a]/70 px-3 py-1 text-[10px] font-semibold text-white sm:mt-1 sm:text-[10.5px]">
        <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
        </svg>
        Approve &amp; send
      </p>
    </div>
  );
}

export function InboxDemoVideo() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const reduced = useReducedMotion();

  // Lazy mount: only attach the <video> once the frame scrolls into view.
  useEffect(() => {
    const node = frameRef.current;
    if (!node || reduced) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [reduced]);

  const showVideo = inView && !reduced && !failed;

  return (
    <figure className="mx-auto mt-6 w-full max-w-md text-left">
      <div
        ref={frameRef}
        className="overflow-hidden rounded-xl border border-border bg-surface shadow-md"
      >
        {/* mini app-window chrome so the teaser reads as a product moment */}
        <div className="flex items-center gap-1.5 border-b border-border bg-surface-2/70 px-3 py-2">
          <span aria-hidden className="size-2 rounded-full bg-border-strong" />
          <span aria-hidden className="size-2 rounded-full bg-border-strong" />
          <span aria-hidden className="size-2 rounded-full bg-border-strong" />
          <span className="ml-2 flex items-center gap-1.5 text-[10.5px] font-semibold text-muted">
            <span aria-hidden className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-success" />
            </span>
            Watch how replies work
          </span>
        </div>
        <div className="relative aspect-video">
          <PosterScene />
          {showVideo ? (
            <video
              src="/demo/buyer-qa.mp4"
              muted
              loop
              playsInline
              autoPlay
              preload="metadata"
              onCanPlay={(e) => {
                void e.currentTarget.play().catch(() => {});
                setPlaying(true);
              }}
              onError={() => setFailed(true)}
              className={`absolute inset-0 size-full object-cover transition-opacity duration-500 ${
                playing ? "opacity-100" : "opacity-0"
              }`}
            />
          ) : null}
        </div>
      </div>
      <figcaption className="mt-2 text-center text-[11.5px] leading-relaxed text-faint">
        A buyer asks · the agent drafts from your listing · you approve &amp; send.
      </figcaption>
    </figure>
  );
}

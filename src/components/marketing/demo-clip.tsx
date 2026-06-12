"use client";

/**
 * DemoClip (subpages v3) — lazy demo-video frame for the how-it-works steps
 * and the buyer-Q&A section.
 *
 * - The video element only mounts once the frame nears the viewport
 *   (IntersectionObserver, 240px rootMargin) and plays/pauses as it enters
 *   and leaves view: autoplay muted loop playsInline, never with sound.
 * - A designed poster (step glyph, title, prism tint, faux player chrome)
 *   renders underneath: it is the loading state AND the permanent fallback
 *   if the clip 404s, so a missing render never looks broken.
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

export function DemoClip({
  src,
  label,
  n,
  title,
  caption,
  glyph,
}: {
  src: string;
  /** Accessible description of the clip's content. */
  label: string;
  /** Step number for the poster slate (e.g. "03"). */
  n?: string;
  title: string;
  caption: string;
  glyph: React.ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reduced = useReducedMotion();
  const [near, setNear] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  // Mount the <video> when the frame approaches the viewport; play/pause it
  // as the frame crosses 35% visibility so off-screen clips don't burn CPU.
  // Under prefers-reduced-motion the designed poster stands in for the loop.
  useEffect(() => {
    if (reduced) return;
    const el = frameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setNear(true);
        const video = videoRef.current;
        if (!video) return;
        if (entry.intersectionRatio >= 0.35) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { rootMargin: "240px 0px", threshold: [0, 0.35] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <div
      ref={frameRef}
      className="glass-panel relative overflow-hidden rounded-2xl"
    >
      <div className="relative aspect-video">
        {/* designed poster / fallback slate */}
        <div className="absolute inset-0 flex flex-col justify-between overflow-hidden bg-night-2 p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(58% 70% at 16% 0%, var(--tint-violet-soft), transparent 70%), radial-gradient(50% 64% at 88% 14%, var(--tint-cyan-soft), transparent 70%)",
            }}
          />
          <div className="relative flex items-start justify-between">
            <span className="flex size-11 items-center justify-center rounded-xl bg-iris/12 text-iris">
              {glyph}
            </span>
            {n ? (
              <span className="nums font-display text-[13px] font-bold text-flash-faint">
                {n}
              </span>
            ) : null}
          </div>
          <div className="relative">
            <p className="font-display text-[19px] font-bold tracking-tight text-flash">
              {title}
            </p>
            <p className="mt-1 max-w-[40ch] text-[12.5px] leading-relaxed text-flash-faint">
              {caption}
            </p>
            {/* faux player rail so the slate reads as a deliberate still */}
            <div className="mt-4 flex items-center gap-2.5">
              <span className="flex size-6 items-center justify-center rounded-full bg-iris text-iris-ink">
                <svg viewBox="0 0 24 24" className="size-2.5" fill="currentColor" aria-hidden>
                  <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.54-6.86a1.04 1.04 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14Z" />
                </svg>
              </span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-panel-2">
                <span className="block h-full w-1/3 rounded-full bg-iris/60" />
              </span>
            </div>
          </div>
        </div>

        {near && !failed ? (
          <video
            ref={videoRef}
            src={src}
            muted
            loop
            playsInline
            autoPlay
            preload="metadata"
            aria-label={label}
            onError={() => setFailed(true)}
            onPlaying={() => setPlaying(true)}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
              playing ? "opacity-100" : "opacity-0"
            }`}
          />
        ) : null}
      </div>
    </div>
  );
}

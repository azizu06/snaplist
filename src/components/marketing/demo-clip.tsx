"use client";

/**
 * DemoClip (subpages v3) — lazy demo-video frame for the how-it-works steps
 * and the buyer-Q&A section.
 *
 * The video engine is SeamlessThemeVideo: it lazy-mounts near the viewport,
 * plays/pauses with visibility, swaps the dark render in on dark mode, and
 * recolours in place on a theme toggle (no restart). A still from the same real
 * dev-preview capture set is the loading, error, and reduced-motion fallback.
 */

import { SeamlessThemeVideo } from "@/components/seamless-theme-video";
import { RealUiCapturePoster } from "@/components/real-ui-capture-poster";

const POSTER_SHOTS: Record<string, string> = {
  snap: "upload-filled",
  identify: "review-identify",
  price: "review-price",
  write: "review-write",
  publish: "publish-live",
  "buyer-qa": "inbox-draft",
};

function posterShot(src: string): string {
  const id = src.split("/").at(-1)?.replace(/\.mp4$/, "") ?? "";
  return POSTER_SHOTS[id] ?? "upload-filled";
}

export function DemoClip({
  src,
  mobileSrc,
  label,
  className,
}: {
  src: string;
  /** Optional action crop shown under 768px (with its `-dark` sibling).
   *  Mobile uses a legible 6:5 focus window; desktop keeps 16:9 context. */
  mobileSrc?: string;
  /** Accessible description of the clip's content. */
  label: string;
  /** Step number for the poster slate (e.g. "3"). */
  n?: string;
  title: string;
  caption: string;
  glyph: React.ReactNode;
  /** Extra classes on the outer frame (ui-r4-hiw; optional, additive). */
  className?: string;
}) {
  return (
    <div
      className={`glass-panel relative overflow-hidden rounded-2xl ${className ?? ""}`}
    >
      <SeamlessThemeVideo
        src={src}
        mobileSrc={mobileSrc}
        label={label}
        lazy
        className={mobileSrc ? "aspect-[6/5] md:aspect-video" : "aspect-video"}
      >
        <RealUiCapturePoster shot={posterShot(src)} label={`${label} (still)`} />
      </SeamlessThemeVideo>
    </div>
  );
}

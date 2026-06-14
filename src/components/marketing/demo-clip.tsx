"use client";

/**
 * DemoClip (subpages v3) — lazy demo-video frame for the how-it-works steps
 * and the buyer-Q&A section.
 *
 * The video engine is SeamlessThemeVideo: it lazy-mounts near the viewport,
 * plays/pauses with visibility, swaps the dark render in on dark mode, and
 * recolours in place on a theme toggle (no restart). The designed poster slate
 * below is passed as its fallback — it is the loading state AND the permanent
 * fallback if a clip 404s, so a missing render never looks broken, and under
 * prefers-reduced-motion it stands alone (no video mounts).
 */

import { SeamlessThemeVideo } from "@/components/seamless-theme-video";

export function DemoClip({
  src,
  label,
  n,
  title,
  caption,
  glyph,
  className,
}: {
  src: string;
  /** Accessible description of the clip's content. */
  label: string;
  /** Step number for the poster slate (e.g. "03"). */
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
      <SeamlessThemeVideo src={src} label={label} lazy className="aspect-video">
        {/* designed poster / fallback slate */}
        <div className="absolute inset-0 flex flex-col justify-between overflow-hidden bg-night-2 p-5 sm:p-7">
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
              <span className="nums font-display text-[14px] font-bold text-flash-faint">
                {n}
              </span>
            ) : null}
          </div>
          <div className="relative">
            <p className="font-display text-[19px] font-bold tracking-tight text-flash sm:text-[22px]">
              {title}
            </p>
            <p className="mt-1 max-w-[40ch] text-[14px] leading-relaxed text-flash-faint sm:text-[15px]">
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
      </SeamlessThemeVideo>
    </div>
  );
}

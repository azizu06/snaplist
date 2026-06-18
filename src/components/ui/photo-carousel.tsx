"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * Shared photo carousel (ui-lifecycle-revamp) — extracted from the upload sheet
 * so the SAME swipeable viewer is used everywhere a seller sees their photos:
 * the upload flow (with a per-photo remove + "Cover" badge) and the review hero
 * (read-only, tap-to-zoom lightbox). One big viewer, object-contain on a clean
 * neutral surface so the whole photo shows without a muddy blurred backdrop, a
 * spring slide between frames, prev/next arrows + dots, and directional swipe
 * (flick or deliberate drag).
 *
 * Modes via props:
 *  - onRemove  → upload: a remove button per photo.
 *  - showCover → upload: the first frame is badged "Cover".
 *  - enableZoom → review: tapping the image opens a full-screen lightbox
 *    (Esc / backdrop / × to close, arrows + swipe to page).
 */

/** Flick power (|offset| × velocity) past which a drag commits to a swipe. */
const SWIPE_CONFIDENCE = 8000;
/** Distance (px) a slow, deliberate drag must cross to commit to a swipe. */
const SWIPE_DISTANCE = 80;

const slideVariants = {
  enter: (dir: number) => ({ x: dir >= 0 ? "100%" : "-100%" }),
  center: { x: 0 },
  exit: (dir: number) => ({ x: dir >= 0 ? "-100%" : "100%" }),
};

const OVERLAY_BTN =
  "flex items-center justify-center rounded-full bg-[#1a1a1a]/70 text-white transition-colors hover:bg-[#1a1a1a]";

export interface PhotoCarouselProps {
  previews: string[];
  current: number;
  onSetCurrent: (i: number) => void;
  /** Upload only: render a per-photo remove button. */
  onRemove?: (i: number) => void;
  /** Upload only: badge the first frame "Cover", others "Photo N". */
  showCover?: boolean;
  /** Review only: tapping the image opens a full-screen zoom lightbox. */
  enableZoom?: boolean;
  /** Show the dot pager under the viewer. Default true; the upload sheet turns
   *  it off because its Shopify-style thumbnail rail already pages the photos. */
  showDots?: boolean;
  /** Tailwind aspect classes for the inline viewer (fallback before the cover
   *  photo is measured, or when adaptiveFrame is off). */
  aspectClassName?: string;
  /** Review: shape the frame to the COVER photo's real aspect ratio (clamped),
   *  so the first photo fills edge-to-edge — no side/letterbox bands — and the
   *  frame stays locked so swiping never reflows the layout. */
  adaptiveFrame?: boolean;
  /** Optional cap on the inline frame HEIGHT (px) for dense edit layouts. The
   *  frame still matches the photo's REAL aspect ratio exactly (adaptiveFrame),
   *  so the image fills it edge-to-edge with NO letterbox/pillar bands — for any
   *  photo, never hardcoded. The cap just bounds how tall a square/portrait shot
   *  gets, by capping the frame's width to `height × aspect` and centering it in
   *  the card. Requires adaptiveFrame. */
  frameMaxHeight?: number;
  className?: string;
}

export function PhotoCarousel({
  previews,
  current,
  onSetCurrent,
  onRemove,
  showCover = false,
  enableZoom = false,
  showDots = true,
  aspectClassName = "aspect-square sm:aspect-[4/3]",
  adaptiveFrame = false,
  frameMaxHeight,
  className = "",
}: PhotoCarouselProps) {
  const count = previews.length;
  const safe = Math.min(Math.max(0, current), count - 1);
  // Direction of the last navigation, fed to the slide variants.
  const [direction, setDirection] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  // Natural aspect (w/h) per photo URL, measured when adaptiveFrame is on, so
  // the frame can match WHICHEVER photo is showing (not just the cover).
  const [aspectByUrl, setAspectByUrl] = useState<Record<string, number>>({});

  const paginate = (target: number, dir: number) => {
    setDirection(dir);
    onSetCurrent(target);
  };
  const next = () => paginate((safe + 1) % count, 1);
  const prev = () => paginate((safe - 1 + count) % count, -1);

  // Lightbox: lock scroll, wire Esc/arrow keys while open.
  useEffect(() => {
    if (!zoomed) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
      else if (e.key === "ArrowRight" && count > 1) next();
      else if (e.key === "ArrowLeft" && count > 1) prev();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
    // next/prev close over `safe`; re-bind when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, safe, count]);

  // Measure EVERY photo up front (cheap, browser-cached) so the frame can snap
  // to the current photo's shape instantly on swipe — every photo fills its own
  // frame, none gets letterboxed into the wrong shape.
  useEffect(() => {
    if (!adaptiveFrame) return;
    let cancelled = false;
    for (const src of previews) {
      const img = new window.Image();
      img.onload = () => {
        if (cancelled || !img.naturalWidth || !img.naturalHeight) return;
        setAspectByUrl((m) =>
          m[src] ? m : { ...m, [src]: img.naturalWidth / img.naturalHeight },
        );
      };
      img.src = src;
    }
    return () => {
      cancelled = true;
    };
  }, [adaptiveFrame, previews]);

  if (count === 0) return null;

  // Frame matches the CURRENT photo (clamped so an extreme pano/tall shot can't
  // make an absurd hero). null until measured → falls back to aspectClassName.
  const measured = aspectByUrl[previews[safe]];
  const frameAspect = measured ? Math.max(0.5, Math.min(2, measured)) : null;

  /** The sliding image — the photo contained on the viewer's clean neutral
   *  surface (no muddy blurred duplicate). Shared by the inline viewer and the
   *  lightbox. A plain JSX factory (not a component) so AnimatePresence keeps
   *  its child identity across renders. */
  const slide = (onImageClick?: () => void) => (
    <AnimatePresence initial={false} custom={direction}>
      <motion.div
        key={safe}
        custom={direction}
        variants={slideVariants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={{ type: "spring", stiffness: 320, damping: 34 }}
        drag={count > 1 ? "x" : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.5}
        onDragEnd={(_event, info) => {
          const power = Math.abs(info.offset.x) * info.velocity.x;
          if (info.offset.x < -SWIPE_DISTANCE || power < -SWIPE_CONFIDENCE) next();
          else if (info.offset.x > SWIPE_DISTANCE || power > SWIPE_CONFIDENCE) prev();
        }}
        className={`absolute inset-0 flex select-none items-center justify-center ${
          count > 1 ? "cursor-grab active:cursor-grabbing" : ""
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- object URL / signed URL */}
        <img
          src={previews[safe]}
          alt={`Photo ${safe + 1} of ${count}`}
          draggable={false}
          onClick={onImageClick}
          className={`size-full rounded-2xl object-contain ${
            onImageClick ? "cursor-zoom-in" : ""
          }`}
        />
      </motion.div>
    </AnimatePresence>
  );

  const renderArrows = (size: string) =>
    count > 1 ? (
      <>
        <button
          type="button"
          onClick={prev}
          aria-label="Previous photo"
          className={`absolute left-3 top-1/2 z-10 -translate-y-1/2 ${size} ${OVERLAY_BTN}`}
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={next}
          aria-label="Next photo"
          className={`absolute right-3 top-1/2 z-10 -translate-y-1/2 ${size} ${OVERLAY_BTN}`}
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </>
    ) : null;

  return (
    <div className={`w-full ${className}`}>
      <div
        className={`relative ${aspectClassName} mx-auto w-full overflow-hidden rounded-2xl border border-border bg-surface-2`}
        style={
          frameAspect
            ? {
                aspectRatio: String(frameAspect),
                // Cap height without ever cropping: the frame already matches the
                // photo's aspect, so capping width to height×aspect bounds the
                // height and just centres a narrower frame (no letterbox bands).
                ...(frameMaxHeight
                  ? { maxWidth: `${Math.round(frameMaxHeight * frameAspect)}px` }
                  : {}),
              }
            : undefined
        }
      >
        {slide(enableZoom ? () => setZoomed(true) : undefined)}

        {/* badge: upload shows Cover/Photo N; review shows a frame counter */}
        {showCover ? (
          <span className="absolute left-3 top-3 z-10 rounded-full bg-[#1a1a1a]/70 px-2.5 py-0.5 text-[11px] font-semibold text-white">
            {safe === 0 ? "Cover" : `Photo ${safe + 1}`}
          </span>
        ) : count > 1 ? (
          <span
            className="absolute left-3 top-3 z-10 rounded-full bg-[#1a1a1a]/70 px-2.5 py-0.5 text-[11px] font-semibold text-white"
            data-nums
          >
            {safe + 1} / {count}
          </span>
        ) : null}

        {/* expand hint (review) */}
        {enableZoom ? (
          <button
            type="button"
            onClick={() => setZoomed(true)}
            aria-label="Expand photo"
            className={`absolute right-3 top-3 z-10 size-9 ${OVERLAY_BTN}`}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
        ) : null}

        {/* remove (upload) */}
        {onRemove ? (
          <button
            type="button"
            onClick={() => onRemove(safe)}
            aria-label="Remove this photo"
            className={`absolute right-3 top-3 z-10 size-9 ${OVERLAY_BTN}`}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : null}

        {renderArrows("size-10")}
      </div>

      {showDots && count > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          {previews.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => paginate(i, i >= safe ? 1 : -1)}
              aria-label={`Go to photo ${i + 1}`}
              aria-current={i === safe}
              // Padded hit area (~24×16px) around a small dot so it's tappable
              // on mobile without enlarging the dot visual.
              className="group flex items-center justify-center px-1 py-2"
            >
              <span
                aria-hidden
                className={`h-2 rounded-full transition-all ${
                  i === safe
                    ? "w-6 bg-accent-solid"
                    : "w-2 bg-border-strong group-hover:bg-muted"
                }`}
              />
            </button>
          ))}
        </div>
      ) : null}

      {/* ---- lightbox ---- */}
      {zoomed ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo viewer"
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close"
            className={`absolute right-4 top-4 z-10 size-10 ${OVERLAY_BTN}`}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative aspect-[4/3] max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-2xl"
          >
            {slide()}
            {renderArrows("size-11")}
            {count > 1 ? (
              <span
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-[#1a1a1a]/70 px-3 py-0.5 text-[12px] font-semibold text-white"
                data-nums
              >
                {safe + 1} / {count}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

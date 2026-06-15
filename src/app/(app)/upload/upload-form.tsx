"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import ClickSpark from "@/components/bits/ClickSpark";
import { Banner } from "@/components/ui/banner";
import { Spinner } from "@/components/ui/spinner";

/**
 * Sell sheet — app-surfaces v4. The default state is composed as "the start
 * of the pipeline", not a form:
 * - a journey rail under the title (add photos → AI identifies & prices →
 *   review & post) so the three-step promise is visible before any photo;
 * - the photo input is a single square CAROUSEL — one viewer, prev/next arrows
 *   + dots, an "Add photo" button (owner: the old cover-plus-tiles grid was
 *   hard to read and cropped portrait shots). Each frame is object-contain over
 *   a blurred fill, so a photo shows exactly as framed. Drag-drop still works,
 *   signalled by a soft breathing violet glow ring + wash;
 * - the field rows live under an "Autofill by SnapList" card header, each with
 *   a leading glyph + the sparkle "AI suggests" pill.
 *
 * Mechanism: a single hidden <input type="file" name="photo" multiple> is kept
 * in sync (via the DataTransfer API) with the `files` array the carousel
 * manages, so the server action still reads formData.getAll("photo") unchanged.
 * Capped at MAX_PHOTOS — every photo is fed into ONE vision call, so each one
 * adds cost/latency (PRD). The PROCESSING view paces the live pipeline stages
 * while the single server action runs.
 */

const ACCEPT = "image/png,image/jpeg,image/webp";
/** All photos go into ONE vision call; the cap bounds cost/latency (PRD). */
const MAX_PHOTOS = 4;

const STEPS = [
  {
    label: "Identifying your item",
    detail: "Reading brand, model, condition, and any barcode from your photos",
  },
  {
    label: "Researching the price",
    detail: "Looking up what this actually sells for used, with sources",
  },
  {
    label: "Drafting the listing",
    detail: "Writing the title and description from the verified details",
  },
] as const;

function ProcessingView({ coverUrl }: { coverUrl: string | null }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    // Pacing only: ~7s per stage, capped at the last (it holds until redirect).
    const timers = [
      setTimeout(() => setStage(1), 7000),
      setTimeout(() => setStage(2), 14000),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs"
    >
      {/* The seller's own photo under the scanner — the pipeline made visible. */}
      {coverUrl ? (
        <div className="relative h-60 overflow-hidden border-b border-border bg-surface-2">
          {/* Blurred fill + object-contain so the scanner shows the seller's
              photo in full (as framed), not a cropped strip. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
          <img
            src={coverUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 size-full scale-110 object-cover blur-xl"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
          <img
            src={coverUrl}
            alt=""
            aria-hidden
            className="relative size-full object-contain"
          />
          <motion.div
            aria-hidden
            className="absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-accent/25 to-transparent"
            initial={{ top: "-12%" }}
            animate={{ top: "104%" }}
            transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
          />
          {/* viewfinder corners */}
          <span aria-hidden className="absolute left-3 top-3 size-5 rounded-tl border-l-[3px] border-t-[3px] border-white drop-shadow" />
          <span aria-hidden className="absolute right-3 top-3 size-5 rounded-tr border-r-[3px] border-t-[3px] border-white drop-shadow" />
          <span aria-hidden className="absolute bottom-3 left-3 size-5 rounded-bl border-b-[3px] border-l-[3px] border-white drop-shadow" />
          <span aria-hidden className="absolute bottom-3 right-3 size-5 rounded-br border-b-[3px] border-r-[3px] border-white drop-shadow" />
        </div>
      ) : null}

      <div className="flex flex-col gap-5 p-5">
        <p className="text-[15px] font-semibold text-fg-strong">
          Building your listing. This usually takes under half a minute.
        </p>
        <ol className="flex flex-col gap-4">
          {STEPS.map((step, i) => (
            <li key={step.label} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                {i < stage ? (
                  <motion.svg
                    viewBox="0 0 24 24"
                    className="size-5 text-success"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 300, damping: 18 }}
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </motion.svg>
                ) : i === stage ? (
                  <Spinner className="size-4 text-accent" />
                ) : (
                  <span className="size-2 rounded-full bg-border-strong" />
                )}
              </span>
              <span>
                <span
                  className={`block text-[15px] font-medium ${
                    i <= stage ? "text-fg-strong" : "text-faint"
                  }`}
                >
                  {step.label}
                </span>
                <AnimatePresence>
                  {i === stage ? (
                    <motion.span
                      className="mt-0.5 block text-[13.5px] text-muted"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                    >
                      {step.detail}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-[13.5px] text-muted">
          Keep this page open and you&apos;ll land on the finished draft
          automatically.
        </p>
      </div>
    </div>
  );
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5c.3 0 .57.2.66.49l1.4 4.6a3 3 0 0 0 1.99 1.99l4.6 1.4a.69.69 0 0 1 0 1.32l-4.6 1.4a3 3 0 0 0-1.99 1.99l-1.4 4.6a.69.69 0 0 1-1.32 0l-1.4-4.6a3 3 0 0 0-1.99-1.99l-4.6-1.4a.69.69 0 0 1 0-1.32l4.6-1.4a3 3 0 0 0 1.99-1.99l1.4-4.6c.09-.29.36-.49.66-.49Z" />
    </svg>
  );
}

const FIELD_ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-3.5",
} as const;

const FIELD_ROWS = [
  {
    label: "Title",
    icon: (
      <svg {...FIELD_ICON_PROPS}>
        <path d="M5 7V5h14v2M12 5v14M9 19h6" />
      </svg>
    ),
  },
  {
    label: "Category",
    icon: (
      <svg {...FIELD_ICON_PROPS}>
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      </svg>
    ),
  },
  {
    label: "Condition",
    icon: (
      <svg {...FIELD_ICON_PROPS}>
        <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.8-5.4 2.8 1-6L3.2 9.4l6.1-.9L12 3z" />
      </svg>
    ),
  },
  {
    label: "Price",
    icon: (
      <svg {...FIELD_ICON_PROPS}>
        <path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17c0 .53.21 1.04.59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42l-8.7-8.7z" />
        <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
      </svg>
    ),
  },
] as const;

/**
 * Field-list row for the fields the pipeline pre-fills. The sparkle badge
 * says the AI *suggests* a value (never locks it) — every one is a real,
 * editable input on the review screen.
 */
function AutoFieldRow({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="flex items-center gap-2.5 text-[15px] font-medium text-fg">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-md bg-surface-2 text-muted"
        >
          {icon}
        </span>
        {label}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-soft-fg">
        <SparkleIcon className="size-2.5" />
        AI suggests
      </span>
    </div>
  );
}

/** Journey rail — the three-step promise, visible before any photo exists. */
function JourneyRail() {
  const steps = [
    { short: "Photos", long: "Add photos", state: "active" as const },
    { short: "AI drafts", long: "AI identifies & prices", state: "next" as const },
    { short: "You review", long: "You review & post", state: "next" as const },
  ];
  return (
    <ol aria-label="How listing works" className="mt-4 flex items-center gap-2">
      {steps.map((step, i) => (
        <li key={step.long} className="flex min-w-0 items-center gap-2">
          {i > 0 ? (
            <span aria-hidden className="h-px w-4 shrink-0 bg-border-strong sm:w-7" />
          ) : null}
          <span
            aria-hidden
            className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold ${
              step.state === "active"
                ? "bg-accent-solid text-accent-fg"
                : "border border-border-strong bg-surface text-muted"
            }`}
          >
            {i + 1}
          </span>
          <span
            className={`truncate text-[13.5px] ${
              step.state === "active"
                ? "font-semibold text-fg-strong"
                : "font-medium text-muted"
            }`}
          >
            <span className="sm:hidden">{step.short}</span>
            <span className="hidden sm:inline">{step.long}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Flick power (|offset| × velocity) past which a drag commits to a swipe. */
const SWIPE_CONFIDENCE = 8000;
/** Distance (px) a slow, deliberate drag must cross to commit to a swipe. */
const SWIPE_DISTANCE = 80;

/**
 * Directional slide: the entering frame comes in from the side you're heading
 * toward, the leaving frame exits the opposite way. `custom` carries the
 * direction (+1 next / -1 prev) into the variants.
 */
const slideVariants = {
  enter: (dir: number) => ({ x: dir >= 0 ? "100%" : "-100%" }),
  center: { x: 0 },
  exit: (dir: number) => ({ x: dir >= 0 ? "-100%" : "100%" }),
};

/**
 * The photo carousel: one big square viewer (object-contain over a blurred
 * fill so the shot shows as framed) that fills the card width, with a smooth
 * spring slide between frames, prev/next arrows + dots, a per-photo remove, and
 * a "Cover" badge on the first (what the pipeline treats as the cover). No
 * fixed slots, no angle labels.
 */
function PhotoCarousel({
  previews,
  current,
  onSetCurrent,
  onRemove,
}: {
  previews: string[];
  current: number;
  onSetCurrent: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  const count = previews.length;
  const safe = Math.min(Math.max(0, current), count - 1);
  // Direction of the last navigation, fed to the slide variants. Set just
  // before we move so the entering/leaving frames travel the right way.
  const [direction, setDirection] = useState(0);

  const paginate = (target: number, dir: number) => {
    setDirection(dir);
    onSetCurrent(target);
  };

  return (
    <div className="w-full">
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-border bg-surface-2 sm:aspect-[4/3]">
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
              // Commit on a fast flick (offset × velocity) OR a deliberate drag
              // past SWIPE_DISTANCE; otherwise it springs back to center.
              const power = Math.abs(info.offset.x) * info.velocity.x;
              if (info.offset.x < -SWIPE_DISTANCE || power < -SWIPE_CONFIDENCE) {
                paginate((safe + 1) % count, 1);
              } else if (info.offset.x > SWIPE_DISTANCE || power > SWIPE_CONFIDENCE) {
                paginate((safe - 1 + count) % count, -1);
              }
            }}
            className={`absolute inset-0 select-none ${
              count > 1 ? "cursor-grab active:cursor-grabbing" : ""
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
            <img
              src={previews[safe]}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 size-full scale-110 object-cover blur-xl"
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
            <img
              src={previews[safe]}
              alt={`Photo ${safe + 1} of ${count}`}
              draggable={false}
              className="relative size-full object-contain"
            />
          </motion.div>
        </AnimatePresence>

        <span className="absolute left-3 top-3 z-10 rounded-full bg-[#131e3a]/70 px-2.5 py-0.5 text-[11px] font-semibold text-white">
          {safe === 0 ? "Cover" : `Photo ${safe + 1}`}
        </span>

        <button
          type="button"
          onClick={() => onRemove(safe)}
          aria-label="Remove this photo"
          className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-full bg-[#131e3a]/70 text-white transition-colors hover:bg-[#131e3a]"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {count > 1 ? (
          <>
            <button
              type="button"
              onClick={() => paginate((safe - 1 + count) % count, -1)}
              aria-label="Previous photo"
              className="absolute left-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-[#131e3a]/70 text-white transition-colors hover:bg-[#131e3a]"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => paginate((safe + 1) % count, 1)}
              aria-label="Next photo"
              className="absolute right-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-[#131e3a]/70 text-white transition-colors hover:bg-[#131e3a]"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </>
        ) : null}
      </div>

      {count > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          {previews.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => paginate(i, i >= safe ? 1 : -1)}
              aria-label={`Go to photo ${i + 1}`}
              aria-current={i === safe}
              className={`h-2 rounded-full transition-all ${
                i === safe
                  ? "w-6 bg-accent-solid"
                  : "w-2 bg-border-strong hover:bg-muted"
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FormBody({
  previews,
  current,
  onSetCurrent,
  onAdd,
  onRemove,
}: {
  previews: string[];
  current: number;
  onSetCurrent: (i: number) => void;
  onAdd: (files: FileList | File[]) => void;
  onRemove: (i: number) => void;
}) {
  const { pending } = useFormStatus();
  const count = previews.length;
  const atMax = count >= MAX_PHOTOS;

  // Drag-and-drop onto the photo card appends to the carousel (capacity is
  // enforced in onAdd). dragDepth tracks nested dragenter/leave pairs.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    onAdd(e.dataTransfer.files);
  };

  if (pending) return <ProcessingView coverUrl={previews[0] ?? null} />;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- the photo carousel. While dragging files anywhere over the card,
           a soft breathing violet glow ring + wash (pointer-events-none
           overlays) signal the drop target. ---- */}
      <section
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragActive(true);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragActive(false);
        }}
        onDrop={handleDrop}
        className="relative rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5"
      >
        {dragActive ? (
          <>
            {/* Calm drop affordance: a soft violet wash + one gently breathing
                glow ring — reads as a glowing border, not a storm. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 rounded-xl bg-accent/10"
            />
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 rounded-xl ring-2 ring-accent/70"
              animate={{
                opacity: [0.6, 1, 0.6],
                boxShadow: [
                  "0 0 10px 1px rgba(109,74,255,0.25)",
                  "0 0 20px 4px rgba(109,74,255,0.45)",
                  "0 0 10px 1px rgba(109,74,255,0.25)",
                ],
              }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-solid px-4 py-1.5 text-[14px] font-semibold text-accent-fg shadow-md"
            >
              Drop photos to add them
            </span>
          </>
        ) : null}

        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-fg-strong">Photos</h2>
          <span className="text-[13.5px] text-muted" data-nums>
            {count}/{MAX_PHOTOS}
          </span>
        </div>

        {/* Shared, hidden picker (no `name` → never submitted). Both the empty
            hero and the "Add photo" button trigger it via htmlFor; on change it
            appends and resets so the same file can be re-picked. */}
        <input
          id="photo-picker"
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) onAdd(e.target.files);
            e.target.value = "";
          }}
        />

        {count === 0 ? (
          <label
            htmlFor="photo-picker"
            className="relative flex aspect-square w-full cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed border-accent/45 bg-accent-soft/35 px-6 text-center sm:aspect-[4/3]"
          >
            <span
              aria-hidden
              className="flex size-12 items-center justify-center rounded-full bg-accent-solid text-accent-fg shadow-md"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
            </span>
            <span>
              <span className="block text-[16px] font-semibold text-fg-strong">
                Add your first photo
              </span>
              <span className="mt-1 block text-[13.5px] leading-relaxed text-muted">
                Drag &amp; drop or click to browse. This becomes the cover
              </span>
            </span>
            <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-[10.5px] font-medium text-faint">
              PNG · JPG · WEBP
            </span>
            <span className="mt-1 max-w-[34ch] text-[12.5px] leading-relaxed text-muted">
              Good light and a clear shot of any label or barcode help the most.
            </span>
          </label>
        ) : (
          <>
            <PhotoCarousel
              previews={previews}
              current={current}
              onSetCurrent={onSetCurrent}
              onRemove={onRemove}
            />
            <div className="mt-3 w-full">
              {!atMax ? (
                <label
                  htmlFor="photo-picker"
                  className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-4 py-2 text-[14px] font-semibold text-fg transition-colors hover:bg-surface-2"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add photo
                </label>
              ) : (
                <p className="text-center text-[13px] text-faint">
                  Up to {MAX_PHOTOS} photos — more angles, better identification.
                </p>
              )}
            </div>
          </>
        )}

      </section>

      {/* ---- Autofill card: callout header + the field rows it fills ---- */}
      <section className="rounded-xl border border-border bg-surface shadow-xs">
        <header className="flex items-center gap-3 rounded-t-xl border-b border-accent/20 bg-accent-soft/50 px-4 py-3 sm:px-5">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-solid text-accent-fg"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-fg-strong">
              Autofill by SnapList
            </p>
            <p className="mt-0.5 text-[13.5px] leading-relaxed text-muted">
              We identify the item, research the used price, and write the
              listing from your photos.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-accent-solid px-2.5 py-0.5 text-[11px] font-semibold text-accent-fg">
            On
          </span>
        </header>
        <div className="px-4 sm:px-5">
          <div className="divide-y divide-border py-1">
            {FIELD_ROWS.map((row) => (
              <AutoFieldRow key={row.label} label={row.label} icon={row.icon} />
            ))}
          </div>
        </div>
      </section>

      {/* ---- sticky bottom CTA bar ---- */}
      <div className="sticky bottom-20 z-10 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-4 sm:mx-0 sm:rounded-xl sm:border sm:shadow-md">
        {/* react-bits ClickSpark: violet burst on the one action that starts
            the whole pipeline. */}
        <ClickSpark
          className="block w-full"
          sparkColor="#6d4aff"
          sparkSize={8}
          sparkRadius={20}
          sparkCount={10}
        >
          <button
            type="submit"
            disabled={count === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[15px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-60"
          >
            Identify, price &amp; draft
          </button>
        </ClickSpark>
      </div>
    </div>
  );
}

export function UploadForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  // The single hidden file input the form actually submits; its FileList is
  // kept in sync with `files` so the server action reads getAll("photo").
  const submitRef = useRef<HTMLInputElement | null>(null);
  // Mirror of `previews` for the unmount cleanup (a state closure there would
  // capture the INITIAL empty array and revoke nothing).
  const previewsRef = useRef<string[]>([]);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  const addFiles = (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter((f) =>
      ACCEPT.split(",").includes(f.type),
    );
    const room = MAX_PHOTOS - files.length;
    if (room <= 0 || accepted.length === 0) return;
    const added = accepted.slice(0, room);
    const urls = added.map((f) => URL.createObjectURL(f));
    setFiles((prev) => [...prev, ...added].slice(0, MAX_PHOTOS));
    setPreviews((prev) => [...prev, ...urls].slice(0, MAX_PHOTOS));
  };

  const removeAt = (index: number) => {
    const url = previews[index];
    if (url) URL.revokeObjectURL(url);
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    // Clamp the viewer to a valid neighbour here (in the handler, not an
    // effect) so we never setState during the render-commit phase.
    setCurrent((c) => {
      const newLen = files.length - 1;
      return newLen <= 0 ? 0 : Math.min(c, newLen - 1);
    });
  };

  // Mirror `files` into the hidden submit input's FileList (DataTransfer is the
  // only way to set input.files programmatically). Runs client-side only.
  useEffect(() => {
    const input = submitRef.current;
    if (!input) return;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
  }, [files]);

  // Revoke whatever object URLs are left on unmount.
  useEffect(() => {
    return () => {
      previewsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  return (
    <form action={action}>
      <input
        ref={submitRef}
        type="file"
        name="photo"
        accept={ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden
        className="sr-only"
      />
      <FormBody
        previews={previews}
        current={current}
        onSetCurrent={setCurrent}
        onAdd={addFiles}
        onRemove={removeAt}
      />
    </form>
  );
}

/**
 * Full sell-sheet surface (header + journey rail + error banner + form) so
 * the page and the dev preview harness render the identical screen.
 */
export function UploadView({
  action,
  actionError,
}: {
  action: (formData: FormData) => Promise<void>;
  actionError: string | null;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          List an item
        </h1>
        <p className="mt-0.5 text-[14px] text-muted">
          Add photos and SnapList fills in the rest for your review.
        </p>
        <JourneyRail />
      </header>

      {actionError ? (
        <Banner variant="error" title="That didn’t work">
          {actionError}
        </Banner>
      ) : null}

      <UploadForm action={action} />
    </main>
  );
}

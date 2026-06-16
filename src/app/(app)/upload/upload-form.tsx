"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import ClickSpark from "@/components/bits/ClickSpark";
import { Banner } from "@/components/ui/banner";
import { PhotoCarousel } from "@/components/ui/photo-carousel";
import { Spinner } from "@/components/ui/spinner";

/**
 * Upload sell sheet — redesigned on Shopify's create/media pattern (Shopify web
 * Jan 2024 #325/#328, "Create collection"): a calm create screen built from
 * sectioned cards, where the photo input is the "Media" card and the start
 * button reads like Shopify's near-black "Save" in the action bar. The loud
 * breathing-violet drag glow of the prior pass is gone — per Shopify's quiet
 * dashed "Add image / or drag and drop to upload" drop zone, the affordance is
 * a neutral dashed tile that shows a single thin accent ring only while a file
 * is over it (UI principles: restraint, kill glows; near-black primary, green
 * accent reserved for emphasis).
 *
 * Sections (mobile-first, one column; cards reuse the app idiom
 * `rounded-2xl border border-border bg-surface shadow-xs`):
 * - a 3-step journey rail under the title (photos → AI drafts → you review);
 * - the Photos card (the shared PhotoCarousel — one object-contain viewer that
 *   keeps photos as-shot, prev/next + dots + swipe, per-photo remove + a
 *   "Cover" badge), drag-and-drop onto the whole card;
 * - the "Autofill by SnapList" card listing the fields the pipeline fills.
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

/** Read the live brand-accent token for the canvas-drawn ClickSpark burst.
 *  SSR-safe: returns `currentColor` on the server / before mount. */
function readAccentColor(): string {
  if (typeof document === "undefined") return "currentColor";
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-accent")
      .trim() || "currentColor"
  );
}

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

/** Journey rail — the three-step promise, visible before any photo exists.
 *  A quiet bordered band gives it presence; the current step's number sits in a
 *  filled green chip (ringed), upcoming steps are hollow. Numbers are centered
 *  with `grid place-items-center` + `leading-none` (flex-centering left them
 *  optically low). */
function JourneyRail() {
  const steps = [
    { short: "Photos", long: "Add photos" },
    { short: "AI drafts", long: "AI identifies & prices" },
    { short: "You review", long: "You review & post" },
  ] as const;
  const activeIndex = 0;
  return (
    <ol
      aria-label="How listing works"
      className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 sm:gap-3 sm:px-4"
    >
      {steps.map((step, i) => {
        const active = i === activeIndex;
        return (
          <li key={step.long} className="flex min-w-0 items-center gap-2 sm:gap-3">
            {i > 0 ? (
              <span aria-hidden className="h-[2px] w-3 shrink-0 rounded-full bg-border-strong sm:w-7" />
            ) : null}
            <span
              aria-hidden
              className={`grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold leading-none tabular-nums ${
                active
                  ? "bg-accent-solid text-accent-fg shadow-sm ring-2 ring-accent/25"
                  : "border-[1.5px] border-border-strong bg-surface text-faint"
              }`}
            >
              {i + 1}
            </span>
            <span
              className={`truncate text-[13px] sm:text-[13.5px] ${
                active ? "font-semibold text-fg-strong" : "font-medium text-muted"
              }`}
            >
              <span className="sm:hidden">{step.short}</span>
              <span className="hidden sm:inline">{step.long}</span>
            </span>
          </li>
        );
      })}
    </ol>
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

  // ClickSpark paints on a <canvas>, so its color must be a real CSS color, not
  // a utility class. Resolve it from the live --color-accent token (never a
  // hardcoded hex) — lazily on first client render, then re-read on theme flip
  // so the burst follows the palette. SSR falls back to currentColor.
  const [sparkColor, setSparkColor] = useState(readAccentColor);
  useEffect(() => {
    const obs = new MutationObserver(() => setSparkColor(readAccentColor()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    onAdd(e.dataTransfer.files);
  };

  if (pending) return <ProcessingView coverUrl={previews[0] ?? null} />;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Photos card (Shopify "Media" section). Drag-and-drop onto the
           whole card; while a file is over it, one quiet accent ring + soft
           wash appear (no glow, no motion) — the restrained drop affordance. ---- */}
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
        className={`relative rounded-2xl border bg-surface p-4 shadow-xs transition-colors sm:p-5 ${
          dragActive ? "border-accent" : "border-border"
        }`}
      >
        {dragActive ? (
          <>
            {/* Calm drop affordance: a single thin accent ring + a faint wash,
                static — reads as "this is the drop target", not a storm. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 rounded-2xl bg-accent-soft/40 ring-2 ring-accent ring-inset"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-fg-strong px-3.5 py-1.5 text-[14px] font-semibold text-surface shadow-sm"
            >
              Drop to add photos
            </span>
          </>
        ) : null}

        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-fg-strong">Photos</h2>
          <span className="text-[13px] text-muted" data-nums>
            {count} of {MAX_PHOTOS}
          </span>
        </div>

        {/* Shared, hidden picker (no `name` → never submitted). Both the empty
            drop zone and the "Add photo" button trigger it via htmlFor; on
            change it appends and resets so the same file can be re-picked. */}
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
          /* Empty drop zone — Shopify's quiet media card: neutral dashed tile,
             a muted icon, an explicit "Add photos" action that reads as a real
             button, and a "or drag and drop" subline. The accent only joins in
             on the drag-over ring above; at rest this is all neutral. */
          <label
            htmlFor="photo-picker"
            className="group relative flex aspect-square w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2/50 px-6 text-center transition-colors hover:border-accent hover:bg-accent-soft/25 sm:aspect-[4/3]"
          >
            <span
              aria-hidden
              className="flex size-11 items-center justify-center rounded-xl bg-surface text-muted shadow-xs ring-1 ring-border transition-colors group-hover:text-accent"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
            </span>
            <span className="flex flex-col items-center gap-1">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3.5 py-1.5 text-[14px] font-semibold text-fg shadow-xs transition-colors group-hover:bg-surface-2">
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add photos
              </span>
              <span className="text-[13px] text-muted">or drag and drop here</span>
            </span>
            <span className="mt-1 max-w-[34ch] text-[12.5px] leading-relaxed text-faint">
              PNG, JPG, or WEBP. The first photo becomes the cover — good light
              and a clear shot of any label or barcode help most.
            </span>
          </label>
        ) : (
          <>
            <PhotoCarousel
              previews={previews}
              current={current}
              onSetCurrent={onSetCurrent}
              onRemove={onRemove}
              showCover
            />
            <div className="mt-4 w-full">
              {!atMax ? (
                <label
                  htmlFor="photo-picker"
                  className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-surface px-4 py-2 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add photo
                </label>
              ) : (
                <p className="text-center text-[13px] text-faint">
                  All {MAX_PHOTOS} photos added — more angles mean a better read.
                </p>
              )}
            </div>
          </>
        )}

      </section>

      {/* ---- Autofill card. Shopify section cards carry a plain title, not a
           saturated band — so the header is neutral chrome; the accent lives
           only on the small sparkle glyph and the "On" status pill. ---- */}
      <section className="rounded-2xl border border-border bg-surface shadow-xs">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3.5 sm:px-5">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-fg"
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
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-0.5 text-[11px] font-semibold text-success-soft-fg">
            <span aria-hidden className="size-1.5 rounded-full bg-success-solid" />
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

      {/* ---- sticky action bar — Shopify's bottom "Save" bar, near-black
           primary. The helper line carries the count state so the disabled
           button is never a dead end. ---- */}
      <div className="sticky bottom-20 z-10 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-4 sm:mx-0 sm:rounded-2xl sm:border sm:shadow-md">
        {/* react-bits ClickSpark: a brand-accent burst on the one action that
            starts the whole pipeline. Spark color is read from the live
            --color-accent token (not hardcoded) so it tracks the palette. */}
        <ClickSpark
          className="block w-full"
          sparkColor={sparkColor}
          sparkSize={8}
          sparkRadius={20}
          sparkCount={10}
        >
          <button
            type="submit"
            disabled={count === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[15px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-50"
          >
            Identify, price &amp; draft
          </button>
        </ClickSpark>
        <p className="mt-2 text-center text-[12.5px] text-muted">
          {count === 0
            ? "Add at least one photo to start."
            : "You review and approve every draft before anything posts."}
        </p>
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

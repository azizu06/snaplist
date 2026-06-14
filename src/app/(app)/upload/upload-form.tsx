"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import ClickSpark from "@/components/bits/ClickSpark";
import ElectricBorder from "@/components/bits/ElectricBorder";
import { Banner } from "@/components/ui/banner";
import { Spinner } from "@/components/ui/spinner";

/**
 * Sell sheet — app-surfaces v3. The default state is composed as "the start
 * of the pipeline", not a form (owner: "the default area still not improved
 * too much"):
 * - a journey rail under the title (add photos → AI identifies & prices →
 *   review & post) so the three-step promise is visible before any photo;
 * - the dropzone is the hero: a large cover slot (drag-drop or browse) over
 *   three labeled angle slots (back/detail/label), ElectricBorder + violet
 *   wash on drag-over;
 * - the Mercari field rows live under an "Autofill by SnapList" card header,
 *   each with a leading glyph + the sparkle "AI suggests" pill.
 *
 * Mechanism is UNCHANGED from round 1 (audit U-1/U-2/U-3): four slot inputs
 * all named `photo` (the server action reads formData.getAll("photo")), slot
 * 1 required, object-URL previews, and the PROCESSING view that paces the
 * live pipeline stages while the single server action runs.
 */

const ACCEPT = "image/png,image/jpeg,image/webp";
const SLOT_COUNT = 4;

/** Angle hints for the three secondary slots (cover is slot 0). */
const ANGLE_HINTS = ["Back", "Detail", "Label"] as const;

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
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
          <img src={coverUrl} alt="" aria-hidden className="size-full object-cover" />
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

function FormBody({
  previews,
  onPick,
  onClear,
  inputRefs,
}: {
  previews: (string | null)[];
  onPick: (slot: number, file: File | null) => void;
  onClear: (slot: number) => void;
  inputRefs: React.MutableRefObject<(HTMLInputElement | null)[]>;
}) {
  const { pending } = useFormStatus();
  const photoCount = previews.filter(Boolean).length;

  // Drag-and-drop onto the photo card: dropped images fill the empty slots
  // in order (the same inputs the click flow uses, so the server action sees
  // identical FormData). dragDepth tracks nested dragenter/leave pairs.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files).filter((f) =>
      ACCEPT.split(",").includes(f.type),
    );
    if (dropped.length === 0) return;
    const emptySlots = previews
      .map((p, slot) => (p ? null : slot))
      .filter((s): s is number => s !== null);
    dropped.slice(0, emptySlots.length).forEach((file, i) => {
      const slot = emptySlots[i];
      const input = inputRefs.current[slot];
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      }
      onPick(slot, file);
    });
  };

  if (pending) return <ProcessingView coverUrl={previews[0]} />;

  const firstEmpty = previews.findIndex((p) => !p);

  return (
    <div className="flex flex-col gap-4">
      {/* ---- the dropzone hero: large cover slot + three labeled angle
           slots. While dragging files anywhere over the card, a react-bits
           ElectricBorder + violet wash (pointer-events-none overlays — the
           inputs never remount) signal the drop target. ---- */}
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
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 rounded-xl bg-accent/5"
            />
            <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
              <ElectricBorder
                color="#6d4aff"
                speed={1.2}
                chaos={0.08}
                borderRadius={14}
                className="size-full"
              />
            </div>
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
            {photoCount}/{SLOT_COUNT}
          </span>
        </div>

        {/* ---- slots: one map, two shapes — slot 0 renders as the
             full-width cover hero, slots 1–3 as labeled angle tiles. ---- */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {Array.from({ length: SLOT_COUNT }, (_, slot) => {
            const preview = previews[slot];
            const isCover = slot === 0;
            const enabled = preview != null || slot === firstEmpty || isCover;
            return (
              <div
                key={slot}
                className={
                  isCover
                    ? `relative col-span-3 h-44 overflow-hidden rounded-2xl sm:h-52 ${
                        preview
                          ? "border border-border"
                          : "border-2 border-dashed border-accent/45 bg-accent-soft/35"
                      }`
                    : `relative aspect-[4/3] overflow-hidden rounded-xl ${
                        preview
                          ? "border border-border"
                          : "border-2 border-dashed border-border-strong bg-surface-2"
                      }`
                }
              >
                <input
                  ref={(el) => {
                    inputRefs.current[slot] = el;
                  }}
                  id={`photo-slot-${slot}`}
                  type="file"
                  name="photo"
                  accept={ACCEPT}
                  required={isCover}
                  disabled={!enabled}
                  onChange={(e) => onPick(slot, e.target.files?.[0] ?? null)}
                  className="sr-only"
                />
                {preview ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                    <img
                      src={preview}
                      alt={isCover ? "Cover photo" : `Photo ${slot + 1}`}
                      className="size-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => onClear(slot)}
                      aria-label={
                        isCover ? "Remove cover photo" : `Remove photo ${slot + 1}`
                      }
                      className={`absolute flex items-center justify-center rounded-full bg-[#131e3a]/70 text-white transition-colors hover:bg-[#131e3a] ${
                        isCover ? "right-2 top-2 size-7" : "right-1 top-1 size-6"
                      }`}
                    >
                      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                    {/* Pinned ink scrim badges — right in both themes on a photo. */}
                    {isCover ? (
                      <span className="absolute left-2 top-2 rounded-full bg-[#131e3a]/70 px-2.5 py-0.5 text-[10.5px] font-semibold text-white">
                        Cover
                      </span>
                    ) : (
                      <span className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-[#131e3a]/70 text-[10px] font-semibold text-white">
                        {slot + 1}
                      </span>
                    )}
                  </>
                ) : isCover ? (
                  <label
                    htmlFor={`photo-slot-${slot}`}
                    className="flex size-full cursor-pointer flex-col items-center justify-center gap-2.5 px-6 text-center"
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
                  </label>
                ) : (
                  <label
                    htmlFor={`photo-slot-${slot}`}
                    className={`flex size-full cursor-pointer flex-col items-center justify-center gap-1 text-faint ${
                      enabled ? "" : "pointer-events-none opacity-40"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    <span className="text-[10.5px] font-medium">
                      {ANGLE_HINTS[slot - 1]}
                    </span>
                  </label>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[13.5px] text-muted">
          Good light and a clear view of labels or barcodes make the
          identification, and the price, much more accurate.
        </p>
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
          <div className="divide-y divide-border">
            {FIELD_ROWS.map((row) => (
              <AutoFieldRow key={row.label} label={row.label} icon={row.icon} />
            ))}
          </div>
          <p className="border-t border-border py-3 text-[13.5px] text-faint">
            Every field stays a real, editable input on the review screen.
          </p>
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
            disabled={photoCount === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[15px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-60"
          >
            Identify, price &amp; draft
          </button>
        </ClickSpark>
        <p className="mt-2 text-center text-[12.5px] text-faint">
          ≈ 30 seconds · nothing posts without your review
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
  const [previews, setPreviews] = useState<(string | null)[]>(
    Array(SLOT_COUNT).fill(null),
  );
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Mirror of `previews` for the unmount cleanup: a state closure in the
  // unmount effect would capture the INITIAL (empty) array and revoke nothing.
  const previewsRef = useRef(previews);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  // Revoke object URLs we replace/remove; revoke whatever is left on unmount.
  const setPreview = (slot: number, url: string | null) => {
    setPreviews((prev) => {
      const old = prev[slot];
      if (old) URL.revokeObjectURL(old);
      const next = [...prev];
      next[slot] = url;
      return next;
    });
  };
  useEffect(() => {
    return () => {
      previewsRef.current.forEach((p) => p && URL.revokeObjectURL(p));
    };
  }, []);

  return (
    <form action={action}>
      <FormBody
        previews={previews}
        inputRefs={inputRefs}
        onPick={(slot, file) =>
          setPreview(slot, file ? URL.createObjectURL(file) : null)
        }
        onClear={(slot) => {
          const input = inputRefs.current[slot];
          if (input) input.value = "";
          setPreview(slot, null);
        }}
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

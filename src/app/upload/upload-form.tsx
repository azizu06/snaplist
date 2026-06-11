"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Banner } from "@/components/ui/banner";
import { Spinner } from "@/components/ui/spinner";

/**
 * Sell sheet — Mercari "List an item" replica (issue #40 round 2; Mobbin
 * Mercari sell-flow references): photo-slot strip up top, an AI-autofill
 * callout row (Mercari's auto-fill toggle analog — ours is always on), then
 * Mercari-style field-list rows (label left, "Auto" pill right, hairline
 * dividers) for the fields the pipeline fills, and a sticky bottom bar with
 * the full-width primary CTA.
 *
 * Mechanism is unchanged from round 1 (audit U-1/U-2/U-3): four slot inputs
 * all named `photo` (the server action reads formData.getAll("photo")), slot
 * 1 required, object-URL previews, and the PROCESSING view that paces the
 * live pipeline stages while the single server action runs.
 */

const ACCEPT = "image/png,image/jpeg,image/webp";
const SLOT_COUNT = 4;

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

function ProcessingView() {
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
      className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-xs"
    >
      <p className="text-sm font-semibold text-fg-strong">
        Building your listing — this usually takes under half a minute.
      </p>
      <ol className="flex flex-col gap-4">
        {STEPS.map((step, i) => (
          <li key={step.label} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
              {i < stage ? (
                <svg viewBox="0 0 24 24" className="size-5 text-success" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : i === stage ? (
                <Spinner className="size-4 text-fg" />
              ) : (
                <span className="size-2 rounded-full bg-border-strong" />
              )}
            </span>
            <span>
              <span
                className={`block text-sm font-medium ${
                  i <= stage ? "text-fg-strong" : "text-faint"
                }`}
              >
                {step.label}
              </span>
              {i === stage ? (
                <span className="mt-0.5 block text-xs text-muted">{step.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">
        Keep this page open — you&apos;ll land on the finished draft automatically.
      </p>
    </div>
  );
}

/** Mercari field-list row: label left, "Auto" pill + chevron right. */
function AutoFieldRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between py-3.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-muted">
          Auto
        </span>
        <svg viewBox="0 0 24 24" className="size-4 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </span>
    </div>
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

  if (pending) return <ProcessingView />;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- photo strip (Mercari: rounded squares, camera on slot 1) ---- */}
      <section className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-fg-strong">Photos</h2>
          <span className="text-xs text-muted" data-nums>
            {photoCount}/{SLOT_COUNT} · first photo is the cover
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {Array.from({ length: SLOT_COUNT }, (_, slot) => {
            const preview = previews[slot];
            const firstEmpty = previews.findIndex((p) => !p);
            const enabled = preview != null || slot === firstEmpty || slot === 0;
            return (
              <div
                key={slot}
                className={`relative aspect-square overflow-hidden rounded-2xl border ${
                  preview
                    ? "border-border"
                    : slot === 0
                      ? "border-2 border-dashed border-accent/50 bg-accent-soft/40"
                      : "border-2 border-dashed border-border-strong bg-surface-2"
                }`}
              >
                <input
                  ref={(el) => {
                    inputRefs.current[slot] = el;
                  }}
                  id={`photo-slot-${slot}`}
                  type="file"
                  name="photo"
                  accept={ACCEPT}
                  required={slot === 0}
                  disabled={!enabled}
                  onChange={(e) => onPick(slot, e.target.files?.[0] ?? null)}
                  className="sr-only"
                />
                {preview ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                    <img
                      src={preview}
                      alt={`Photo ${slot + 1}`}
                      className="size-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => onClear(slot)}
                      aria-label={`Remove photo ${slot + 1}`}
                      className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-fg-strong/70 text-white transition-colors hover:bg-fg-strong"
                    >
                      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                    <span className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-fg-strong/70 text-[10px] font-semibold text-white">
                      {slot + 1}
                    </span>
                  </>
                ) : (
                  <label
                    htmlFor={`photo-slot-${slot}`}
                    className={`flex size-full cursor-pointer flex-col items-center justify-center gap-1 ${
                      enabled ? "" : "pointer-events-none opacity-40"
                    } ${slot === 0 ? "text-accent-soft-fg" : "text-faint"}`}
                  >
                    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {slot === 0 ? (
                        <>
                          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                          <circle cx="12" cy="13" r="3" />
                        </>
                      ) : (
                        <>
                          <path d="M12 5v14" />
                          <path d="M5 12h14" />
                        </>
                      )}
                    </svg>
                    <span className="text-[10px] font-medium">
                      {slot === 0 ? "Add photo" : `Photo ${slot + 1}`}
                    </span>
                  </label>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted">
          Good light and a clear view of labels or barcodes make the
          identification — and the price — much more accurate.
        </p>
      </section>

      {/* ---- AI autofill callout (Mercari's auto-fill toggle analog) ---- */}
      <section className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3">
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
          <p className="text-[13px] font-semibold text-fg-strong">
            Autofill by SnapList
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            We identify the item, research the used price, and write the
            listing from your photos.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-accent-solid px-2.5 py-0.5 text-[11px] font-semibold text-accent-fg">
          On
        </span>
      </section>

      {/* ---- field list (Mercari rows the pipeline fills) ---- */}
      <section className="rounded-xl border border-border bg-surface px-4 shadow-xs sm:px-5">
        <div className="divide-y divide-border">
          <AutoFieldRow label="Title" />
          <AutoFieldRow label="Category" />
          <AutoFieldRow label="Condition" />
          <AutoFieldRow label="Price" />
        </div>
        <p className="pb-3 text-xs text-faint">
          Filled automatically once your photos are analyzed — you review
          everything before it posts.
        </p>
      </section>

      {/* ---- sticky bottom CTA bar (Mercari "List" bar) ---- */}
      <div className="sticky bottom-16 z-10 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-4 sm:mx-0 sm:rounded-xl sm:border sm:shadow-md">
        <button
          type="submit"
          disabled={photoCount === 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-60"
        >
          Identify, price &amp; draft
        </button>
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
 * Full sell-sheet surface (header + error banner + form) so the page and the
 * dev preview harness render the identical screen.
 */
export function UploadView({
  action,
  actionError,
}: {
  action: (formData: FormData) => Promise<void>;
  actionError: string | null;
}) {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-bold tracking-tight text-fg-strong">
          List an item
        </h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Add photos — SnapList fills in the rest for your review.
        </p>
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

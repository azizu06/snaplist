"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/ui/spinner";

/**
 * Photo-first capture (audit U-1/U-2/U-3, Mercari pattern):
 * - Four numbered photo slots, each its own optional file input (all named
 *   `photo` — the server action reads formData.getAll("photo")). Slot 1 is
 *   required; previews confirm what's attached; remove buttons clear a slot.
 * - Submitting swaps the form for the PROCESSING view that names the live
 *   pipeline stages (Identifying → Pricing → Drafting). Stage advance is
 *   time-based pacing of a single server action, not per-stage telemetry —
 *   the final stage holds a spinner until the action redirects.
 *
 * The server action is the same one as before (AC5): this component only adds
 * client affordances around it.
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
      className="flex flex-col gap-5 rounded-lg border border-info-border bg-info-soft p-5"
    >
      <p className="text-sm font-semibold text-info-soft-fg">
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
                <Spinner className="size-4 text-info-soft-fg" />
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
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-4 gap-2 sm:gap-3">
        {Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const preview = previews[slot];
          const firstEmpty = previews.findIndex((p) => !p);
          const enabled = preview != null || slot === firstEmpty || slot === 0;
          return (
            <div
              key={slot}
              className={`relative aspect-square overflow-hidden rounded-xl border ${
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

      <p className="text-xs text-muted">
        Tip: good light and a clear view of labels or barcodes make the
        identification — and the price — much more accurate. Up to 4 angles.
      </p>

      <button
        type="submit"
        disabled={photoCount === 0}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-accent-solid px-4 py-2.5 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-60"
      >
        Identify, price &amp; draft
      </button>
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

  // Revoke object URLs we replace/remove; revoke all on unmount.
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
      previews.forEach((p) => p && URL.revokeObjectURL(p));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup
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

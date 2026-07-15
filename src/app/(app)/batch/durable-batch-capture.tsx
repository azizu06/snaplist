"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PipelineRunProgress } from "@/components/pipeline-run-progress";
import { Banner } from "@/components/ui/banner";
import type { PipelineProgressRun } from "@/lib/pipeline-progress";
import { appendAcceptedPhotos, MAX_PHOTOS } from "../upload/upload-draft-context";
import { PhotoInputActions } from "../upload/photo-input-actions";

interface CapturedEntry {
  key: string;
  files: File[];
  previews: string[];
  costBasis: string;
}

export interface DurableBatchCaptureProps {
  userId: string;
  initialBatchId: string;
  initialRuns: PipelineProgressRun[];
}

export function DurableBatchCapture({
  userId,
  initialBatchId,
  initialRuns,
}: DurableBatchCaptureProps) {
  const router = useRouter();
  const [entries, setEntries] = useState<CapturedEntry[]>([]);
  const [current, setCurrent] = useState<CapturedEntry>({
    key: crypto.randomUUID(),
    files: [],
    previews: [],
    costBasis: "",
  });
  const [runs, setRuns] = useState(initialRuns);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objectUrls = useRef<string[]>([]);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const addPhotos = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const selected = Array.from(incoming);
    setCurrent((entry) => {
      const accepted = appendAcceptedPhotos(entry.files, selected);
      const urls = accepted.added.map((file) => URL.createObjectURL(file));
      objectUrls.current.push(...urls);
      if (accepted.rejectedCount > 0) {
        setError("Some photos were skipped. Use PNG, JPEG, or WEBP.");
      } else if (accepted.overflowCount > 0) {
        setError(`Up to ${MAX_PHOTOS} photos per item.`);
      }
      return {
        ...entry,
        files: accepted.files,
        previews: [...entry.previews, ...urls],
      };
    });
  }, []);

  const commitCurrent = useCallback(() => {
    if (current.files.length === 0) return;
    setEntries((saved) => [...saved, current]);
    setCurrent({ key: crypto.randomUUID(), files: [], previews: [], costBasis: "" });
  }, [current]);

  const submit = async () => {
    const batch = current.files.length > 0 ? [...entries, current] : entries;
    if (batch.length === 0) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.set(
      "manifest",
      JSON.stringify({
        batchId: initialBatchId,
        entries: batch.map((entry) => ({
          idempotencyKey: entry.key,
          costBasis: entry.costBasis.trim() || null,
          photoCount: entry.files.length,
        })),
      }),
    );
    batch.forEach((entry, index) => {
      entry.files.forEach((file) => form.append(`photo:${index}`, file));
    });

    try {
      const response = await fetch("/api/batch/enqueue", { method: "POST", body: form });
      const body = (await response.json()) as {
        error?: string;
        batchId?: string;
        runs?: Array<{
          id: string;
          itemId: string;
          listingId: string | null;
          status: PipelineProgressRun["status"];
          stage: PipelineProgressRun["stage"];
          attemptCount: number;
          maxAttempts: number;
          safeFailureMessage: string | null;
          updatedAt: string;
        }>;
      };
      if (!response.ok || !body.batchId || !body.runs) {
        throw new Error(body.error ?? "We couldn't save this batch for processing.");
      }
      setRuns(
        body.runs.map((run) => ({
          id: run.id,
          user_id: userId,
          item_id: run.itemId,
          listing_id: run.listingId,
          status: run.status,
          stage: run.stage,
          attempt_count: run.attemptCount,
          max_attempts: run.maxAttempts,
          safe_failure_message: run.safeFailureMessage,
          updated_at: run.updatedAt,
        })),
      );
      setEntries(batch);
      setCurrent({ key: crypto.randomUUID(), files: [], previews: [], costBasis: "" });
      router.replace(`/batch?batch=${body.batchId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We couldn't save this batch for processing.");
    } finally {
      setSubmitting(false);
    }
  };

  if (runs.length > 0) {
    return (
      <main
        data-testid="durable-progress"
        className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6"
      >
        <header>
          <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
            Batch progress
          </h1>
          <p className="mt-1 text-[14px] leading-relaxed text-muted">
            Every accepted item is saved. You can close this page and return to the same batch.
          </p>
        </header>
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {runs.map((run, index) => (
            <PipelineRunProgress
              key={run.id}
              userId={userId}
              initialRun={run}
              title={`Item ${index + 1}`}
              reviewHref={`/review/${run.item_id}?ready=1`}
              onRunChange={(next) =>
                setRuns((currentRuns) =>
                  currentRuns.map((candidate) => candidate.id === next.id ? next : candidate),
                )
              }
            />
          ))}
        </div>
      </main>
    );
  }

  const total = entries.length + (current.files.length > 0 ? 1 : 0);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Bulk capture
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          Add each item, then save the whole batch to your processing queue.
        </p>
      </header>

      {error ? <Banner variant="error" title="That didn't work">{error}</Banner> : null}

      {entries.length > 0 ? (
        <section className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
          <h2 className="text-[14px] font-semibold text-fg-strong">Saved in this batch</h2>
          <ul className="mt-3 flex min-w-0 gap-2 overflow-x-auto pb-1">
            {entries.map((entry, index) => (
              <li key={entry.key} className="w-20 shrink-0 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
                <img src={entry.previews[0]} alt={`Item ${index + 1}`} className="size-20 rounded-lg border border-border object-cover" />
                <span className="mt-1 block text-[11px] text-muted">Item {index + 1}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-semibold text-fg-strong">Item {entries.length + 1}</h2>
          <span className="text-[13px] text-muted">{current.files.length} of {MAX_PHOTOS} photos</span>
        </div>
        {current.previews.length > 0 ? (
          <div className="mt-3 flex min-w-0 gap-2 overflow-x-auto pb-1">
            {current.previews.map((src, index) => (
              // eslint-disable-next-line @next/next/no-img-element -- local preview
              <img key={src} src={src} alt={`Photo ${index + 1}`} className="size-20 shrink-0 rounded-lg border border-border object-cover" />
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-border-strong bg-surface-2 p-6 text-center text-[13px] text-muted">
            Add 1 to 4 photos of this item.
          </p>
        )}
        <PhotoInputActions
          idPrefix="durable-batch-item"
          disabled={current.files.length >= MAX_PHOTOS || submitting}
          onSelect={addPhotos}
          className="mt-3"
        />
        <label className="mt-4 block text-[13px] font-medium text-fg-strong" htmlFor="batch-cost-basis">
          What did you pay? <span className="font-normal text-faint">Optional</span>
        </label>
        <div className="relative mt-1.5">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[14px] text-muted">$</span>
          <input
            id="batch-cost-basis"
            inputMode="decimal"
            value={current.costBasis}
            onChange={(event) => setCurrent((entry) => ({ ...entry, costBasis: event.target.value }))}
            className="w-full rounded-lg border border-border-strong bg-bg py-2 pl-7 pr-3 text-[15px] text-fg-strong outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            placeholder="Leave blank if you don't know"
          />
        </div>
      </section>

      <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-4 sm:mx-0 sm:rounded-2xl sm:border sm:shadow-md">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={current.files.length === 0 || submitting} onClick={commitCurrent} className="rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[14px] font-semibold text-fg disabled:opacity-50">
            Next item
          </button>
          <button type="button" disabled={total === 0 || submitting} onClick={() => void submit()} className="rounded-lg bg-primary px-3 py-2.5 text-[14px] font-semibold text-primary-fg disabled:opacity-50">
            {submitting ? "Saving batch" : `Process ${total || ""} ${total === 1 ? "item" : "items"}`}
          </button>
        </div>
        <p className="mt-2 text-center text-[12.5px] text-muted">
          Processing starts only after every accepted item is saved.
        </p>
      </div>
    </main>
  );
}

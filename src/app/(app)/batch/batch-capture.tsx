"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/badge";
import {
  DEFAULT_BATCH_CONCURRENCY,
  runBatch,
  runEntry,
  type BatchEntryState,
  type BatchRunOutcome,
} from "@/lib/batch/orchestrate";
import {
  triageLabel,
  triageStatusFromListing,
  type TriageStatusKey,
} from "@/lib/batch/status";
import { ACCEPT, MAX_PHOTOS } from "../upload/upload-draft-context";

/**
 * Bulk / haul capture (issue #100) — the reseller-native flow: photograph item
 * after item in one session (1–4 photos each, "Next item" advances), then
 * submit the whole batch and land on a live triage list.
 *
 * Mobile-web first, one-handed: the only always-needed controls (add photo /
 * next item / process batch) live in a sticky thumb-zone bar; everything above
 * is glanceable state. Visual idiom is the existing app language — sectioned
 * `rounded-2xl border border-border bg-surface shadow-xs` cards, the shared
 * StatusBadge tones — no new styles invented.
 *
 * Orchestration: submitting runs each captured item through the EXISTING
 * single-item pipeline via POST /api/batch/item (auth → rate limit → daily
 * quota → storage → runPipelineAndPersist), with small bounded concurrency
 * (`runBatch`) so those guardrails stay authoritative. Per-item failure is
 * isolated with a Retry; a daily-quota denial blocks the rest of the batch
 * with a clear message instead of hammering the API. The triage list then
 * polls /api/batch/status so row states track DB truth (queued → published).
 *
 * Photos are in-memory Files (like the single-item upload draft): a full page
 * reload starts a fresh capture session, but every item already submitted is
 * persisted and lives on the dashboard/review pages — nothing is lost.
 */

interface CapturedItem {
  /** Local key for React lists + object-URL lifetime. */
  key: string;
  files: File[];
  previews: string[];
  state: BatchEntryState;
  /** Latest DB truth from the status poll (listing status + title). */
  polledStatus?: string | null;
  polledTitle?: string | null;
}

const ACCEPTED_TYPES = ACCEPT.split(",");
const POLL_MS = 5000;

/** POST one item's photos through the single-item pipeline route. */
async function submitItem(files: File[]): Promise<BatchRunOutcome> {
  const fd = new FormData();
  for (const f of files) fd.append("photo", f);
  let res: Response;
  try {
    res = await fetch("/api/batch/item", { method: "POST", body: fd });
  } catch {
    return { ok: false, kind: "error", message: "Network error. Please retry." };
  }
  let body: {
    itemId?: string;
    listingId?: string;
    listingStatus?: string;
    error?: string;
    kind?: string;
  } | null = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  if (res.ok && body?.itemId && body?.listingId) {
    return {
      ok: true,
      itemId: body.itemId,
      listingId: body.listingId,
      listingStatus: body.listingStatus ?? "draft",
    };
  }
  const kind =
    body?.kind === "quota"
      ? ("quota" as const)
      : body?.kind === "rate-limit" || res.status === 429
        ? ("rate-limit" as const)
        : ("error" as const);
  return {
    ok: false,
    kind,
    message: body?.error ?? "Something went wrong. Please retry this item.",
  };
}

/** The triage-list reading of one entry: orchestrator state + polled DB truth. */
function entryTriageStatus(item: CapturedItem): TriageStatusKey {
  switch (item.state.phase) {
    case "waiting":
      return "waiting";
    case "running":
      return "processing";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "done":
      return triageStatusFromListing(item.polledStatus ?? item.state.listingStatus);
  }
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

export function BatchCaptureView() {
  const [phase, setPhase] = useState<"capture" | "triage">("capture");
  const [items, setItems] = useState<CapturedItem[]>([]);
  // Photos being staged for the CURRENT item (not yet committed to the batch).
  const [staged, setStaged] = useState<{ files: File[]; previews: string[] }>({
    files: [],
    previews: [],
  });
  const [notice, setNotice] = useState<string | null>(null);

  // Mirror items into a ref so the async orchestrator + retry handlers always
  // read the current array without re-binding.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Revoke every object URL on unmount only (previews live for the session).
  const allPreviewsRef = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of allPreviewsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const addStagedFiles = useCallback((incoming: FileList | File[]) => {
    setNotice(null);
    const accepted = Array.from(incoming).filter((f) =>
      ACCEPTED_TYPES.includes(f.type),
    );
    if (accepted.length < Array.from(incoming).length) {
      setNotice("Some files were skipped — use PNG, JPEG, or WEBP.");
    }
    setStaged((prev) => {
      const room = MAX_PHOTOS - prev.files.length;
      const take = accepted.slice(0, Math.max(0, room));
      if (accepted.length > room) {
        setNotice(`Up to ${MAX_PHOTOS} photos per item — extra photos were skipped.`);
      }
      const urls = take.map((f) => URL.createObjectURL(f));
      allPreviewsRef.current.push(...urls);
      return {
        files: [...prev.files, ...take],
        previews: [...prev.previews, ...urls],
      };
    });
  }, []);

  const removeStagedAt = useCallback((index: number) => {
    setStaged((prev) => ({
      files: prev.files.filter((_, i) => i !== index),
      previews: prev.previews.filter((_, i) => i !== index),
    }));
  }, []);

  /** Commit the staged photos as the next item in the batch. */
  const commitStaged = useCallback((): boolean => {
    if (staged.files.length === 0) return false;
    setItems((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        files: staged.files,
        previews: staged.previews,
        state: { phase: "waiting" },
      },
    ]);
    setStaged({ files: [], previews: [] });
    return true;
  }, [staged]);

  const removeItem = useCallback((key: string) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  const patchItem = useCallback(
    (index: number, patch: Partial<CapturedItem>) => {
      setItems((prev) =>
        prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
      );
    },
    [],
  );

  /** Submit the batch: capture → triage, then orchestrate the pipeline runs. */
  const processBatch = useCallback(() => {
    // Auto-commit any staged photos so "snap 4 photos then hit Process" works
    // without an explicit final "Next item".
    let batch = itemsRef.current;
    if (staged.files.length > 0) {
      const committed: CapturedItem = {
        key: crypto.randomUUID(),
        files: staged.files,
        previews: staged.previews,
        state: { phase: "waiting" },
      };
      batch = [...batch, committed];
      setItems(batch);
      setStaged({ files: [], previews: [] });
    }
    if (batch.length === 0) return;
    setPhase("triage");
    const snapshot = batch; // files are immutable per entry from here on
    void runBatch(
      snapshot.length,
      (i) => submitItem(snapshot[i].files),
      {
        concurrency: DEFAULT_BATCH_CONCURRENCY,
        onUpdate: (i, state) => patchItem(i, { state }),
      },
    );
  }, [staged, patchItem]);

  /** Retry one failed/blocked entry through the same guarded runner. */
  const retryItem = useCallback(
    async (index: number) => {
      const item = itemsRef.current[index];
      if (!item) return;
      patchItem(index, { state: { phase: "running" } });
      const outcome = await runEntry(() => submitItem(item.files), index);
      if (outcome.ok) {
        patchItem(index, {
          state: {
            phase: "done",
            itemId: outcome.itemId,
            listingId: outcome.listingId,
            listingStatus: outcome.listingStatus,
          },
        });
      } else if (outcome.kind === "quota") {
        patchItem(index, { state: { phase: "blocked", message: outcome.message } });
      } else {
        patchItem(index, {
          state: { phase: "failed", kind: outcome.kind, message: outcome.message },
        });
      }
    },
    [patchItem],
  );

  // Triage poll: refresh created items' listing status from DB truth every 5s
  // (covers autopilot `queued` flipping to `published` after the run reported).
  useEffect(() => {
    if (phase !== "triage") return;
    const tick = async () => {
      const created = itemsRef.current
        .map((it, i) => ({ it, i }))
        .filter(({ it }) => it.state.phase === "done");
      if (created.length === 0) return;
      const ids = created.map(({ it }) =>
        it.state.phase === "done" ? it.state.itemId : "",
      );
      try {
        const res = await fetch(`/api/batch/status?ids=${ids.join(",")}`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          items?: Array<{ id: string; listingStatus: string | null; title: string | null }>;
        };
        if (!body.items) return;
        const byId = new Map(body.items.map((r) => [r.id, r]));
        for (const { it, i } of created) {
          if (it.state.phase !== "done") continue;
          const row = byId.get(it.state.itemId);
          if (row) {
            patchItem(i, { polledStatus: row.listingStatus, polledTitle: row.title });
          }
        }
      } catch {
        // Poll failures are silent — the next tick retries; the rows keep
        // their last honest state.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(interval);
  }, [phase, patchItem]);

  return phase === "capture" ? (
    <CapturePhase
      items={items}
      staged={staged}
      notice={notice}
      onAddStaged={addStagedFiles}
      onRemoveStaged={removeStagedAt}
      onCommitStaged={commitStaged}
      onRemoveItem={removeItem}
      onProcess={processBatch}
    />
  ) : (
    <TriagePhase items={items} onRetry={retryItem} />
  );
}

/* ------------------------------- capture ------------------------------- */

function CapturePhase({
  items,
  staged,
  notice,
  onAddStaged,
  onRemoveStaged,
  onCommitStaged,
  onRemoveItem,
  onProcess,
}: {
  items: CapturedItem[];
  staged: { files: File[]; previews: string[] };
  notice: string | null;
  onAddStaged: (files: FileList | File[]) => void;
  onRemoveStaged: (index: number) => void;
  onCommitStaged: () => boolean;
  onRemoveItem: (key: string) => void;
  onProcess: () => void;
}) {
  const stagedCount = staged.files.length;
  const totalItems = items.length + (stagedCount > 0 ? 1 : 0);
  const atMax = stagedCount >= MAX_PHOTOS;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Bulk capture
        </h1>
        <p className="mt-0.5 text-[14px] text-muted">
          Photograph item after item — SnapList lists the whole haul.
        </p>
      </header>

      {notice ? (
        <Banner variant="error" title="Heads up">
          {notice}
        </Banner>
      ) : null}

      {/* Committed items strip */}
      {items.length > 0 ? (
        <section className="rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-fg-strong">In this batch</h2>
            <span className="text-[13px] text-muted" data-nums>
              {items.length} {items.length === 1 ? "item" : "items"}
            </span>
          </div>
          <ul className="flex items-center gap-2 overflow-x-auto pb-1">
            {items.map((item, i) => (
              <li key={item.key} className="relative shrink-0">
                <div className="relative size-16 overflow-hidden rounded-lg border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
                  <img src={item.previews[0]} alt={`Item ${i + 1}`} className="size-full object-cover" />
                  <span className="absolute bottom-0 inset-x-0 bg-fg-strong/70 py-0.5 text-center text-[10px] font-semibold text-surface">
                    {item.files.length} {item.files.length === 1 ? "photo" : "photos"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveItem(item.key)}
                  aria-label={`Remove item ${i + 1} from batch`}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-fg-strong text-surface shadow-sm transition-colors hover:bg-danger"
                >
                  <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Current item card */}
      <section className="rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-fg-strong">
            Item {items.length + 1}
          </h2>
          <span className="text-[13px] text-muted" data-nums>
            {stagedCount} of {MAX_PHOTOS} photos
          </span>
        </div>

        <input
          id="batch-photo-picker"
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) onAddStaged(e.target.files);
            e.target.value = "";
          }}
        />

        {stagedCount === 0 ? (
          <label
            htmlFor="batch-photo-picker"
            className="group flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2/50 px-6 text-center transition-colors hover:border-accent hover:bg-accent-soft/25"
          >
            <span
              aria-hidden
              className="flex size-11 items-center justify-center rounded-xl bg-surface text-muted shadow-xs ring-1 ring-border transition-colors group-hover:text-accent"
            >
              <CameraIcon className="size-5" />
            </span>
            <span className="flex flex-col items-center gap-1">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3.5 py-1.5 text-[14px] font-semibold text-fg shadow-xs transition-colors group-hover:bg-surface-2">
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add photos
              </span>
              <span className="text-[13px] text-muted">
                1–4 per item. First photo is the cover.
              </span>
            </span>
          </label>
        ) : (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {staged.previews.map((src, i) => (
              <div key={src} className="relative shrink-0">
                <div className="relative size-20 overflow-hidden rounded-lg border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
                  <img src={src} alt={`Photo ${i + 1}`} className="size-full object-cover" />
                  {i === 0 ? (
                    <span className="absolute bottom-1 left-1 rounded bg-fg-strong/70 px-1 py-0.5 text-[9px] font-semibold text-surface">
                      Cover
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveStaged(i)}
                  aria-label={`Remove photo ${i + 1}`}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-fg-strong text-surface shadow-sm transition-colors hover:bg-danger"
                >
                  <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
            {!atMax ? (
              <label
                htmlFor="batch-photo-picker"
                aria-label="Add photo"
                className="flex size-20 shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-border-strong bg-surface-2/50 text-muted transition-colors hover:border-accent hover:bg-accent-soft/25 hover:text-accent"
              >
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span className="text-[11px] font-medium">Add</span>
              </label>
            ) : null}
          </div>
        )}
      </section>

      {/* Sticky thumb-zone action bar: Next item + Process batch. */}
      <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-4 sm:mx-0 sm:rounded-2xl sm:border sm:shadow-md">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={stagedCount === 0}
            onClick={() => onCommitStaged()}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-[15px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Next item
          </button>
          <button
            type="button"
            disabled={totalItems === 0}
            onClick={onProcess}
            className="inline-flex flex-1 items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-[15px] font-semibold text-primary-fg shadow-xs transition-all duration-150 hover:bg-primary-hover hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
          >
            Process {totalItems > 0 ? `${totalItems} ${totalItems === 1 ? "item" : "items"}` : "batch"}
          </button>
        </div>
        <p className="mt-2 text-center text-[12.5px] text-muted">
          {totalItems === 0
            ? "Add photos of your first item to start the haul."
            : stagedCount > 0
              ? "“Next item” saves this one and starts the next."
              : "Add the next item’s photos, or process the batch."}
        </p>
      </div>
    </main>
  );
}

/* -------------------------------- triage -------------------------------- */

function TriagePhase({
  items,
  onRetry,
}: {
  items: CapturedItem[];
  onRetry: (index: number) => void;
}) {
  const statuses = items.map(entryTriageStatus);
  const doneCount = statuses.filter(
    (s) => s !== "waiting" && s !== "processing",
  ).length;
  const needsRetry = statuses.filter((s) => s === "failed" || s === "blocked").length;
  const inFlight = doneCount < items.length;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Batch triage
        </h1>
        <p className="mt-0.5 flex items-center gap-2 text-[14px] text-muted" data-nums>
          {inFlight ? <Spinner className="size-3.5 text-accent" /> : null}
          {doneCount} of {items.length} processed
          {needsRetry > 0 ? ` · ${needsRetry} need${needsRetry === 1 ? "s" : ""} a retry` : ""}
        </p>
      </header>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
        <ul className="divide-y divide-border">
          {items.map((item, i) => {
            const status = statuses[i];
            const label = triageLabel(status);
            const itemId = item.state.phase === "done" ? item.state.itemId : null;
            const failureMessage =
              item.state.phase === "failed" || item.state.phase === "blocked"
                ? item.state.message
                : null;
            return (
              <li key={item.key} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <div className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
                  <img src={item.previews[0]} alt="" className="size-full object-cover" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-fg-strong">
                    {item.polledTitle ?? `Item ${i + 1}`}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge label={label.label} tone={label.tone} pulse={label.pulse} />
                  </div>
                  {failureMessage ? (
                    <p className="mt-1 text-[12.5px] text-muted">{failureMessage}</p>
                  ) : null}
                </div>
                {itemId ? (
                  <Link
                    href={`/review/${itemId}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[13.5px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
                  >
                    Review
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </Link>
                ) : status === "failed" || status === "blocked" ? (
                  <button
                    type="button"
                    onClick={() => onRetry(i)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[13.5px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5" />
                    </svg>
                    Retry
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <p className="text-center text-[12.5px] text-muted">
        Every processed item is saved — you can leave this page and finish
        reviewing from your dashboard anytime.
      </p>

      {!inFlight ? (
        <div className="flex justify-center">
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-[15px] font-semibold text-primary-fg shadow-xs transition-all duration-150 hover:bg-primary-hover hover:shadow-md"
          >
            Go to dashboard
          </Link>
        </div>
      ) : null}
    </main>
  );
}

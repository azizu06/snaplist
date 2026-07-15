"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/ui/badge";
import { useSupabaseClient } from "@/lib/supabase/client";
import {
  connectionAfterJoinTimeout,
  connectionFromChannelStatus,
  REALTIME_JOIN_TIMEOUT_MS,
  type RealtimeConnectionState,
} from "@/lib/ui/realtime-status";
import {
  isPipelineProgressTerminal,
  PIPELINE_PROGRESS_SELECT,
  pipelineProgressRunSchema,
  pipelineProgressSteps,
  pipelineProgressView,
  type PipelineProgressRun,
} from "@/lib/pipeline-progress";

export const PIPELINE_PROGRESS_POLL_MS = 5_000;

export function isPipelineProgressUpdateStale(
  candidate: PipelineProgressRun,
  accepted: PipelineProgressRun,
): boolean {
  const candidateTime = Date.parse(candidate.updated_at);
  const acceptedTime = Date.parse(accepted.updated_at);
  if (Number.isFinite(candidateTime) && Number.isFinite(acceptedTime)) {
    return candidateTime < acceptedTime;
  }
  return candidate.updated_at < accepted.updated_at;
}

export interface PipelineProgressCardProps {
  run: PipelineProgressRun;
  connection: RealtimeConnectionState;
  reviewHref?: string;
  refreshing?: boolean;
  refreshFailed?: boolean;
  onRefresh?: () => void;
  onRetryConnection?: () => void;
  title?: string;
}

export function PipelineProgressCard({
  run,
  connection,
  reviewHref,
  refreshing = false,
  refreshFailed = false,
  onRefresh,
  onRetryConnection,
  title = "Building your listing",
}: PipelineProgressCardProps) {
  const view = pipelineProgressView(run);
  const steps = pipelineProgressSteps(run);
  const terminal = isPipelineProgressTerminal(run.status);

  return (
    <section
      data-testid="run-row"
      data-run-id={run.id}
      data-run-status={run.status}
      className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-xs"
    >
      <div className="min-w-0 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
              {title}
            </p>
            <div role="status" aria-live="polite" aria-atomic="true" className="mt-2 min-w-0">
              <StatusBadge label={view.label} tone={view.tone} pulse={view.pulse} />
              <p className="mt-2 max-w-[58ch] break-words text-[14px] leading-relaxed text-muted">
                {view.detail}
              </p>
            </div>
          </div>
          {run.attempt_count > 0 ? (
            <span className="shrink-0 text-[12px] text-faint" data-nums>
              Attempt {run.attempt_count} of {run.max_attempts}
            </span>
          ) : null}
        </div>
      </div>

      <ol
        aria-label="Listing progress"
        className="grid min-w-0 grid-cols-1 divide-y divide-border px-4 sm:grid-cols-5 sm:divide-x sm:divide-y-0 sm:px-0"
      >
        {steps.map((step) => (
          <li
            key={step.key}
            aria-current={step.state === "current" ? "step" : undefined}
            className="flex min-w-0 items-center gap-2 py-2.5 sm:flex-col sm:items-start sm:gap-1.5 sm:px-3 sm:py-3"
          >
            <span
              aria-hidden
              className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-bold ${
                step.state === "complete"
                  ? "border-success bg-success-soft text-success-soft-fg"
                  : step.state === "current"
                    ? "border-info-border bg-info-soft text-info-soft-fg"
                    : "border-border-strong bg-surface-2 text-faint"
              }`}
            >
              {step.state === "complete" ? "✓" : ""}
            </span>
            <span
              className={`min-w-0 break-words text-[12.5px] leading-snug ${
                step.state === "upcoming" ? "text-faint" : "font-medium text-fg-strong"
              }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>

      <div className="flex min-w-0 flex-col gap-2 border-t border-border bg-surface-2/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        {!terminal ? (
          <p className="min-w-0 break-words text-[12.5px] text-faint">
            {connection === "live"
              ? "Live updates on"
              : connection === "failed"
                ? "Live updates unavailable. Checking saved status every 5 seconds."
                : "Connecting to live updates. Checking saved status every 5 seconds."}
          </p>
        ) : (
          <span />
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {refreshFailed ? (
            <span className="text-[12px] text-danger-soft-fg">Could not refresh yet.</span>
          ) : null}
          {connection === "failed" && !terminal && onRetryConnection ? (
            <button
              type="button"
              onClick={onRetryConnection}
              className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] font-semibold text-fg transition-colors hover:bg-surface-2 motion-reduce:transition-none"
            >
              Retry live updates
            </button>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] font-semibold text-fg transition-colors hover:bg-surface-2 disabled:opacity-60 motion-reduce:transition-none"
            >
              {refreshing ? "Refreshing" : "Refresh status"}
            </button>
          ) : null}
          {run.status === "succeeded" && reviewHref ? (
            <Link
              href={reviewHref}
              className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-fg transition-colors hover:bg-primary-hover motion-reduce:transition-none"
            >
              Review draft
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export interface PipelineRunProgressProps {
  userId: string;
  initialRun: PipelineProgressRun;
  reviewHref?: string;
  title?: string;
  onRunChange?: (run: PipelineProgressRun) => void;
}

export function PipelineRunProgress({
  userId,
  initialRun,
  reviewHref,
  title,
  onRunChange,
}: PipelineRunProgressProps) {
  const supabase = useSupabaseClient();
  const [liveRun, setLiveRun] = useState<PipelineProgressRun | null>(null);
  const [connection, setConnection] = useState<RealtimeConnectionState>("connecting");
  const [subscribeAttempt, setSubscribeAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const acceptedRunRef = useRef(initialRun);
  const run =
    liveRun?.id === initialRun.id && !isPipelineProgressUpdateStale(liveRun, initialRun)
      ? liveRun
      : initialRun;
  const terminal = isPipelineProgressTerminal(run.status);

  useEffect(() => {
    if (
      acceptedRunRef.current.id !== initialRun.id
      || isPipelineProgressUpdateStale(acceptedRunRef.current, initialRun)
    ) {
      acceptedRunRef.current = initialRun;
    }
  }, [initialRun]);

  const acceptRun = useCallback(
    (raw: unknown) => {
      const parsed = pipelineProgressRunSchema.safeParse(raw);
      if (!parsed.success || parsed.data.user_id !== userId || parsed.data.id !== initialRun.id) {
        return;
      }
      if (isPipelineProgressUpdateStale(parsed.data, initialRun)) return;
      if (
        acceptedRunRef.current.id === parsed.data.id
        && isPipelineProgressUpdateStale(parsed.data, acceptedRunRef.current)
      ) return;
      acceptedRunRef.current = parsed.data;
      setLiveRun(parsed.data);
      onRunChange?.(parsed.data);
    },
    [initialRun, onRunChange, userId],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const { data, error } = await supabase
      .from("pipeline_runs")
      .select(PIPELINE_PROGRESS_SELECT)
      .eq("id", initialRun.id)
      .maybeSingle();
    if (error || !data) {
      setRefreshFailed(true);
    } else {
      setRefreshFailed(false);
      acceptRun(data);
    }
    setRefreshing(false);
  }, [acceptRun, initialRun.id, supabase]);

  useEffect(() => {
    if (terminal) return;
    let cancelled = false;
    const channel = supabase
      .channel(`pipeline-run-${initialRun.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "pipeline_runs",
          filter: `id=eq.${initialRun.id}`,
        },
        (payload) => acceptRun(payload.new),
      )
      .subscribe((status, error) => {
        if (cancelled) return;
        if (error || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("[realtime] pipeline run channel", status);
        }
        setConnection(connectionFromChannelStatus(status));
        if (status === "SUBSCRIBED") void refresh();
      });
    const joinTimer = setTimeout(() => {
      if (!cancelled) setConnection((current) => connectionAfterJoinTimeout(current));
    }, REALTIME_JOIN_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(joinTimer);
      void supabase.removeChannel(channel);
    };
  }, [acceptRun, initialRun.id, refresh, subscribeAttempt, supabase, terminal]);

  useEffect(() => {
    if (terminal || connection === "live") return;
    const timer = setInterval(() => void refresh(), PIPELINE_PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [connection, refresh, terminal]);

  const retryConnection = () => {
    setConnection("connecting");
    setSubscribeAttempt((attempt) => attempt + 1);
  };

  return (
    <PipelineProgressCard
      run={run}
      connection={connection}
      reviewHref={reviewHref}
      refreshing={refreshing}
      refreshFailed={refreshFailed}
      onRefresh={() => void refresh()}
      onRetryConnection={retryConnection}
      title={title}
    />
  );
}

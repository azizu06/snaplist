"use client";

import { motion, useReducedMotion } from "motion/react";
import { StatusBadge } from "@/components/ui/badge";
import type { StatusTone } from "@/lib/ui/status";
import type { MessageRow } from "@/lib/inbox";

/**
 * Conversation list — the presentational thread surface for the buyer inbox.
 *
 * Extracted from InboxClient (mirrors how SimulatorCard was split out) so the
 * dev preview can render the EXACT same populated thread from fixtures while the
 * live inbox wires it to Realtime state. All state-machine logic stays in the
 * client; this component only renders a question + its reply state and emits
 * callbacks.
 *
 * Modeled on Shopify's order-timeline + comment composer (Mobbin "Shopify web
 * Jan 2024" #600 and the Send-invoice draft/review modal): a leading initials
 * square, a right-aligned relative timestamp + status chip, an inline message
 * card, and ONE primary action per row — restrained chrome, color carried by a
 * single dot, the draft marked by a quiet sparkle rather than a loud fill.
 */

/** Sparkle burst marking agent-drafted content (mirrors the marketing InboxVisual). */
function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2m0-12.8-2.2 2.2M7.8 16.2l-2.2 2.2" />
    </svg>
  );
}

/** Buyer avatar — a calm initials square (Shopify timeline uses the same). */
function BuyerAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted ${className ?? ""}`}
    >
      {/* generic buyer glyph — we don't know the real handle in the sandbox */}
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 21a7 7 0 0 0-14 0" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </span>
  );
}

/** Compact relative timestamp (Shopify timeline: "Just now", "2 minutes ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export interface ConversationListProps {
  inbound: MessageRow[];
  repliesByQuestion: Map<string, MessageRow>;
  /** Seller edits keyed by message id; absent → show the agent's draft as-is. */
  edits: Record<string, string>;
  /** Which row (and action) is in flight: "send:<id>" | "retry:<id>" | "redraft:<id>". */
  busy: string | null;
  onEdit: (id: string, value: string) => void;
  onApproveAndSend: (message: MessageRow) => void;
  onRetryDelivery: (message: MessageRow) => void;
  onRetryDraft: (message: MessageRow) => void;
}

export function ConversationList({
  inbound,
  repliesByQuestion,
  edits,
  busy,
  onEdit,
  onApproveAndSend,
  onRetryDelivery,
  onRetryDraft,
}: ConversationListProps) {
  // Entrance stagger is skipped entirely under prefers-reduced-motion.
  const reduceMotion = useReducedMotion();

  return (
    <ul className="flex flex-col gap-3">
      {inbound.map((message, index) => {
        const sentReply = repliesByQuestion.get(message.id);
        const draftValue = edits[message.id] ?? message.draft_reply ?? "";
        // Claimed-but-undelivered (PR #35 review): the inbound row is `sent` but
        // no outbound row references it — delivery failed (or the process
        // crashed) after the CAS claim, before the outbound insert. While OUR
        // send request is in flight (busy) the two Realtime events (UPDATE then
        // INSERT) may arrive split, so that window renders as "sending", not as
        // a delivery failure.
        const sending =
          message.status === "sent" && !sentReply && busy === `send:${message.id}`;
        const undelivered = message.status === "sent" && !sentReply && !sending;
        const statusTone: StatusTone =
          undelivered || message.status === "draft_failed"
            ? "danger"
            : message.status === "sent"
              ? "success-solid"
              : "neutral";
        const statusLabel = undelivered
          ? "Not delivered"
          : message.status === "sent"
            ? sending
              ? "Sending…"
              : "Replied"
            : message.status === "drafted"
              ? "Draft ready"
              : message.status === "draft_failed"
                ? "Draft failed"
                : "Drafting…";

        return (
          <motion.li
            key={message.id}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: "easeOut", delay: index * 0.06 }}
            className="rounded-xl border border-border bg-surface shadow-xs"
          >
            {/* ── question row: avatar · bubble · timestamp + status ── */}
            <div className="flex items-start gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
              <BuyerAvatar />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-[13px] font-semibold text-fg-strong">
                    Buyer
                    <span className="ml-1.5 font-normal text-faint">via eBay</span>
                  </p>
                  <time
                    data-nums
                    dateTime={message.created_at}
                    className="shrink-0 text-[12px] text-faint"
                  >
                    {relativeTime(message.created_at)}
                  </time>
                </div>
                <p className="mt-1.5 text-[15px] leading-relaxed text-fg">
                  {message.body}
                </p>
              </div>
            </div>

            {/* ── reply state ── */}
            <div className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
              {undelivered ? (
                <div className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft px-3.5 py-3">
                  <p className="text-[12.5px] font-semibold text-danger-soft-fg">
                    Reply not delivered. Delivery failed after your approval.
                  </p>
                  {message.draft_reply ? (
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-fg">
                      {message.draft_reply}
                    </p>
                  ) : null}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRetryDelivery(message)}
                      disabled={busy === `retry:${message.id}`}
                      className="rounded-lg bg-danger-solid px-3.5 py-1.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
                    >
                      {busy === `retry:${message.id}` ? "Retrying…" : "Retry delivery"}
                    </button>
                  </div>
                </div>
              ) : message.status === "draft_failed" ? (
                <div className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft px-3.5 py-3">
                  <p className="text-[12.5px] font-semibold text-danger-soft-fg">
                    Draft failed. We couldn&apos;t write a reply for this one.
                  </p>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRetryDraft(message)}
                      disabled={busy === `redraft:${message.id}`}
                      className="rounded-lg bg-danger-solid px-3.5 py-1.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
                    >
                      {busy === `redraft:${message.id}` ? "Retrying…" : "Retry draft"}
                    </button>
                  </div>
                </div>
              ) : message.status === "sent" ? (
                <div className="rounded-lg border border-brand-tint bg-brand-soft px-3.5 py-3">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-accent-soft-fg">
                    <svg
                      viewBox="0 0 24 24"
                      className="size-3 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Your reply
                    {sentReply?.sent_at ? (
                      <span className="font-normal text-accent-soft-fg/70">
                        · sent (stubbed delivery)
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed text-fg">
                    {sentReply?.body ?? message.draft_reply}
                  </p>
                </div>
              ) : message.status === "drafted" ? (
                <div className="flex flex-col gap-2.5">
                  <div className="rounded-lg border border-brand-tint bg-brand-soft px-3.5 py-3">
                    <label
                      htmlFor={`reply-${message.id}`}
                      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-semibold text-accent-soft-fg"
                    >
                      <SparkleIcon className="size-3 shrink-0" />
                      Drafted from your listing · edit before sending
                      {message.draft_model ? (
                        <span className="font-normal text-accent-soft-fg/70">
                          · {message.draft_model}
                        </span>
                      ) : null}
                    </label>
                    <textarea
                      id={`reply-${message.id}`}
                      value={draftValue}
                      onChange={(e) => onEdit(message.id, e.target.value)}
                      rows={3}
                      className="mt-2 w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[15px] leading-relaxed text-fg outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent/30"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-3">
                    <span className="hidden text-[13px] text-faint sm:inline">
                      Nothing sends until you approve
                    </span>
                    <button
                      type="button"
                      onClick={() => onApproveAndSend(message)}
                      disabled={busy === `send:${message.id}`}
                      className="rounded-lg bg-primary px-4 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60"
                    >
                      {busy === `send:${message.id}` ? "Sending…" : "Approve & send"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2/60 px-3.5 py-3">
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-faint motion-reduce:animate-none"
                  />
                  <p className="text-[15px] text-muted">
                    Drafting a reply from your listing…
                  </p>
                </div>
              )}
            </div>

            {/* status chip pinned to the row foot so the card reads top-down */}
            <div className="flex items-center justify-end border-t border-border px-4 py-2 sm:px-5">
              <StatusBadge label={statusLabel} tone={statusTone} />
            </div>
          </motion.li>
        );
      })}
    </ul>
  );
}

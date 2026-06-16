"use client";

import { useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "motion/react";
import { StatusBadge } from "@/components/ui/badge";
import type { StatusTone } from "@/lib/ui/status";
import type { MessageRow } from "@/lib/inbox";

/**
 * Buyer inbox — two-pane messaging surface.
 *
 * Split from InboxClient (mirrors how SimulatorCard was split out) so the dev
 * preview renders the EXACT same surface from fixtures while the live inbox
 * wires it to Realtime state. All state-machine logic stays in the client; these
 * components only render and emit callbacks.
 *
 *   • ConversationList  — left pane: one row per buyer conversation (item title,
 *     last-message snippet, unread dot, relative time, active highlight).
 *   • ConversationThread — right pane: the question + reply state as chat bubbles
 *     (buyer inbound vs. your outbound), with the AI-draft composer at the foot
 *     (approve / edit-before-send preserved verbatim).
 *
 * One inbound question is one conversation: the data model threads a single
 * buyer question to its single approved reply via `reply_to`, so a row == an
 * inbound message and its (optional) sent reply. "Unread" is derived — a
 * conversation reads unread until you've replied (status `sent` with a reply).
 */

/* ────────────────────────────── shared helpers ────────────────────────────── */

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
      className={`flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted ${className ?? ""}`}
    >
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
  return stableLabel(iso);
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Hydration-stable absolute label derived ONLY from the ISO via UTC fields —
 *  no Date.now(), no locale/timezone — so the server render and the first
 *  client render always agree. */
function stableLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Am I hydrated?" via useSyncExternalStore — returns false on the server +
 *  first client paint, then true once hydrated. The React-recommended hydration
 *  signal (same pattern as login-aurora's useMediaQuery); avoids setState-in-
 *  effect. The subscribe is a stable no-op (the value never changes after mount). */
const subscribeNoop = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Hydration-safe timestamp (Codex P2). `relativeTime()` reads `Date.now()` and a
 * locale-dependent absolute, so rendering it during SSR + hydration can diverge
 * near a minute/hour/day boundary or across timezones and trip a Next hydration
 * mismatch. So we render the deterministic absolute label on the server + first
 * client paint, then upgrade to the live relative label once hydrated.
 */
function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const hydrated = useHydrated();
  return (
    <time
      data-nums
      dateTime={iso}
      className={`shrink-0 text-[12px] text-faint ${className ?? ""}`}
      suppressHydrationWarning
    >
      {hydrated ? relativeTime(iso) : stableLabel(iso)}
    </time>
  );
}

/**
 * Per-conversation reply state, derived once and shared by the list row (snippet
 * + status) and the thread (which bubble/composer to render). Keeping the
 * derivation in one place keeps the two panes in lockstep.
 */
export interface ConversationState {
  message: MessageRow;
  sentReply: MessageRow | undefined;
  sending: boolean;
  undelivered: boolean;
  statusTone: StatusTone;
  statusLabel: string;
  /** Unread = a buyer question still waiting on you (not yet replied/sent ok). */
  unread: boolean;
  /** What the row preview shows under the title. */
  snippet: string;
}

export function deriveConversationState(
  message: MessageRow,
  repliesByQuestion: Map<string, MessageRow>,
  busy: string | null,
): ConversationState {
  const sentReply = repliesByQuestion.get(message.id);
  // Claimed-but-undelivered (PR #35 review): the inbound row is `sent` but no
  // outbound row references it — delivery failed (or the process crashed) after
  // the CAS claim, before the outbound insert. While OUR send request is in
  // flight (busy) the two Realtime events (UPDATE then INSERT) may arrive split,
  // so that window renders as "sending", not as a delivery failure.
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

  // Resolved only once the reply is delivered (sent + outbound row present).
  const unread = !(message.status === "sent" && !!sentReply);

  const snippet = sentReply
    ? `You: ${sentReply.body}`
    : message.status === "drafted" && message.draft_reply
      ? `Draft: ${message.draft_reply}`
      : message.body;

  return {
    message,
    sentReply,
    sending,
    undelivered,
    statusTone,
    statusLabel,
    unread,
    snippet,
  };
}

/* ────────────────────────────── left pane: list ───────────────────────────── */

export interface ConversationListProps {
  inbound: MessageRow[];
  repliesByQuestion: Map<string, MessageRow>;
  busy: string | null;
  /** Item id → display label, so a row can name the listing it's about. */
  itemLabels: Map<string, string>;
  /** Currently selected conversation (inbound message id), or null. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** A buyer's display name for the sandbox — we don't know the real handle, so a
 *  short, stable, non-placeholder label keyed off the item it's about. */
function buyerLabel(itemLabels: Map<string, string>, message: MessageRow): string {
  const item = message.item_id ? itemLabels.get(message.item_id) : undefined;
  return item ?? "Buyer question";
}

export function ConversationList({
  inbound,
  repliesByQuestion,
  busy,
  itemLabels,
  selectedId,
  onSelect,
}: ConversationListProps) {
  const reduceMotion = useReducedMotion();

  return (
    <ul className="flex flex-col">
      {inbound.map((message, index) => {
        const state = deriveConversationState(message, repliesByQuestion, busy);
        const active = message.id === selectedId;
        return (
          <motion.li
            key={message.id}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut", delay: index * 0.04 }}
          >
            <button
              type="button"
              onClick={() => onSelect(message.id)}
              aria-current={active ? "true" : undefined}
              className={`group flex w-full items-start gap-3 border-l-2 px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                active
                  ? "border-l-accent bg-brand-soft"
                  : "border-l-transparent hover:bg-surface-2/60"
              }`}
            >
              <BuyerAvatar />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className={`truncate text-[14px] ${
                      state.unread
                        ? "font-semibold text-fg-strong"
                        : "font-medium text-fg"
                    }`}
                  >
                    {buyerLabel(itemLabels, message)}
                  </span>
                  <RelativeTime iso={message.created_at} />
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px] ${
                      state.unread ? "text-fg" : "text-muted"
                    }`}
                  >
                    {state.snippet}
                  </span>
                  {state.unread ? (
                    <span
                      aria-label="Unread"
                      className={`size-2 shrink-0 rounded-full ${
                        state.undelivered || message.status === "draft_failed"
                          ? "bg-danger"
                          : "bg-accent-solid"
                      }`}
                    />
                  ) : null}
                </span>
              </span>
            </button>
          </motion.li>
        );
      })}
    </ul>
  );
}

/* ────────────────────────── right pane: the thread ────────────────────────── */

export interface ConversationThreadProps {
  state: ConversationState;
  buyerName: string;
  /** Seller edits keyed by message id; absent → show the agent's draft as-is. */
  edits: Record<string, string>;
  busy: string | null;
  onEdit: (id: string, value: string) => void;
  onApproveAndSend: (message: MessageRow) => void;
  onRetryDelivery: (message: MessageRow) => void;
  onRetryDraft: (message: MessageRow) => void;
  /** Mobile only — return to the list pane. */
  onBack?: () => void;
}

export function ConversationThread({
  state,
  buyerName,
  edits,
  busy,
  onEdit,
  onApproveAndSend,
  onRetryDelivery,
  onRetryDraft,
  onBack,
}: ConversationThreadProps) {
  const { message, sentReply, undelivered, statusTone, statusLabel } = state;
  const draftValue = edits[message.id] ?? message.draft_reply ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── thread header: who + what + status ── */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 lg:hidden"
            aria-label="Back to conversations"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        ) : null}
        <BuyerAvatar />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-fg-strong">
            {buyerName}
          </p>
          <p className="truncate text-[12.5px] text-faint">Buyer · via eBay</p>
        </div>
        <StatusBadge label={statusLabel} tone={statusTone} />
      </header>

      {/* ── message history (scrolls) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {/* inbound buyer bubble */}
          <div className="flex flex-col items-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-border bg-surface-2 px-4 py-2.5">
              <p className="text-[15px] leading-relaxed text-fg">{message.body}</p>
            </div>
            <RelativeTime iso={message.created_at} className="mt-1 px-1" />
          </div>

          {/* outbound — sent reply (your delivered message) */}
          {message.status === "sent" && !undelivered ? (
            <div className="flex flex-col items-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-brand-tint bg-brand-soft px-4 py-2.5">
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
                <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-fg">
                  {sentReply?.body ?? message.draft_reply}
                </p>
              </div>
              {sentReply?.sent_at ? (
                <RelativeTime iso={sentReply.sent_at} className="mt-1 px-1" />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── composer / recovery dock (pinned) ── */}
      <div className="border-t border-border bg-surface px-4 py-4 sm:px-5">
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
          <p className="flex items-center justify-center gap-1.5 py-1 text-[13px] text-faint">
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Replied — nothing further to send
          </p>
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
    </div>
  );
}

/* ────────────────────── right pane: nothing selected ──────────────────────── */

/** Calm desktop placeholder shown when there are conversations but none picked. */
export function ThreadPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-accent-soft-fg"
      >
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <h3 className="mt-4 text-[16px] font-semibold text-fg-strong">
        Select a conversation
      </h3>
      <p className="mt-1.5 max-w-xs text-[14px] leading-relaxed text-muted">
        Pick a buyer question on the left to read the thread and review the
        drafted reply before it sends.
      </p>
    </div>
  );
}

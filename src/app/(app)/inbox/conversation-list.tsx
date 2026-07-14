"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { StatusTone } from "@/lib/ui/status";
import type { MessageRow } from "@/lib/inbox";
import {
  canRetryDelivery,
  deliveryRecoveryLabel,
  requiresDuplicateRiskConfirmation,
} from "./delivery-recovery";

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

/**
 * Buyer avatar — a calm monogram tile (Shopify-style). Shows the conversation's
 * initial in the brand tint so each buyer reads as a distinct person instead of
 * an identical generic glyph. We don't have a real buyer name or photo in v1
 * (eBay's member-messaging API exposes only the buyer's username, no photo, and
 * it isn't stored yet), so the initial is derived from the conversation label;
 * `name` falls back to "B" for an unlabeled question. Sizable via `className`.
 */
function BuyerAvatar({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  const initial = (name?.trim()?.charAt(0) || "B").toUpperCase();
  return (
    <span
      aria-hidden
      className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[15px] font-bold leading-none text-accent-soft-fg shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${className ?? ""}`}
    >
      {initial}
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

/** Live media-query hook (same useSyncExternalStore pattern as login-aurora's);
 *  `serverFallback` is the SSR/first-paint snapshot. */
function useMediaQuery(query: string, serverFallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverFallback,
  );
}

/**
 * "Is the two-pane desktop layout active?" (Tailwind `lg`, 1024px). Drives the
 * inbox's render fork: desktop keeps the thread in the static side-by-side pane;
 * below `lg` the thread becomes a single-pane slide-over. The SSR/first-paint
 * snapshot is `true` so the desktop two-pane paints without a flash; a phone
 * corrects to the slide-over the instant it hydrates (and since the thread pane
 * is `display:none` under `lg` via CSS, nothing is visibly wrong in between).
 * Gating on this keeps EXACTLY ONE ConversationThread mounted — no duplicate
 * `reply-<id>` input ids across the two layouts.
 */
export function useIsDesktopPane(): boolean {
  return useMediaQuery("(min-width: 1024px)", true);
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
  delivered: boolean;
  sending: boolean;
  undelivered: boolean;
  canRetryFollowUps: boolean;
  statusTone: StatusTone;
  statusLabel: string;
  /** Unread = a buyer question still waiting on you (not yet replied/sent ok). */
  unread: boolean;
  /** What the row preview shows under the title. */
  snippet: string;
}

const POLICY_SOURCE_LABELS: Record<string, string> = {
  active_listing_specific: "current listing fact",
  seller_confirmed_measurement: "seller-confirmed measurement",
  current_asking_price: "current asking price",
  active_listing_state: "active listing state",
  seller_approved_policy: "seller-approved policy",
};

/** Compact, seller-readable projection of the structured authorization audit. */
export function messagePolicyEvidenceLabel(message: MessageRow): string | null {
  if (!message.policy_outcome) return null;
  const reference = message.policy_grounding_references?.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null,
  );
  const source =
    typeof reference?.source === "string"
      ? POLICY_SOURCE_LABELS[reference.source]
      : undefined;
  if (message.delivery_status === "delivered") {
    return message.policy_delivery_actor === "automatic"
      ? `Automatically sent${source ? ` · ${source}` : ""}`
      : "Seller-approved reply sent";
  }
  if (message.policy_delivery_status === "blocked") {
    return "Automatic send blocked · Needs your approval";
  }
  if (
    message.policy_outcome === "auto_send" &&
    message.policy_delivery_status === "not_attempted"
  ) {
    return "Automatic reply queued";
  }
  if (message.policy_outcome === "escalate") return "Needs seller check";
  if (message.policy_outcome === "draft_for_approval") return "Needs your approval";
  return null;
}

export function canonicalReplyFailureLabel(message: MessageRow): string {
  return message.policy_delivery_actor === "automatic"
    ? "Automatic reply not delivered. The failure is safe to retry."
    : "Reply not delivered. Delivery failed after your approval.";
}

export function deriveConversationState(
  message: MessageRow,
  repliesByQuestion: Map<string, MessageRow>,
  busy: string | null,
): ConversationState {
  const sentReply = repliesByQuestion.get(message.id);
  const delivered = sentReply?.delivery_status === "delivered";
  const externallyAnswered = message.status === "externally_answered";
  const providerUnavailable = message.status === "provider_unavailable";
  const canRetryFollowUps = !externallyAnswered && !providerUnavailable;
  // Claimed-but-undelivered (PR #35 review): the inbound row is `sent` but no
  // outbound row references it — delivery failed (or the process crashed) after
  // the CAS claim, before the outbound insert. While OUR send request is in
  // flight (busy) the two Realtime events (UPDATE then INSERT) may arrive split,
  // so that window renders as "sending", not as a delivery failure.
  const sending =
    message.status === "sent" && !delivered && busy === `send:${message.id}`;
  const undelivered = message.status === "sent" && !delivered && !sending;
  const statusTone: StatusTone =
    undelivered || message.status === "draft_failed"
      ? "danger"
      : delivered
        ? "success-solid"
        : "neutral";
  const statusLabel = externallyAnswered
    ? "Answered on eBay"
    : providerUnavailable
      ? "No longer active on eBay"
    : undelivered
    ? deliveryRecoveryLabel(
        message.delivery_status,
        message.delivery_attempted_at,
      )
    : delivered
      ? message.policy_delivery_actor === "automatic"
        ? "Automatically sent"
        : "Replied"
      : message.status === "sent"
      ? sending
        ? "Sending…"
        : "Not delivered"
      : message.status === "drafted"
        ? "Draft ready"
        : message.status === "draft_failed"
          ? "Draft failed"
          : "Drafting…";

  // Resolved only once the reply is delivered (sent + outbound row present).
  const unread = !delivered && !externallyAnswered && !providerUnavailable;

  const snippet = sentReply
    ? `You: ${sentReply.body}`
    : providerUnavailable && message.draft_reply
      ? message.draft_reply
    : message.status === "drafted" && message.draft_reply
      ? `Draft: ${message.draft_reply}`
      : message.body;

  return {
    message,
    sentReply,
    delivered,
    sending,
    undelivered,
    canRetryFollowUps,
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

export function conversationRowClassName(active: boolean): string {
  return `group flex min-w-0 w-full max-w-full overflow-hidden items-start gap-3 px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
    active ? "bg-brand-soft" : "hover:bg-surface-2/60"
  }`;
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
              className={conversationRowClassName(active)}
            >
              <BuyerAvatar name={buyerLabel(itemLabels, message)} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span
                    className={`truncate text-[15px] ${
                      state.unread
                        ? "font-semibold text-fg-strong"
                        : "font-medium text-fg"
                    }`}
                  >
                    {buyerLabel(itemLabels, message)}
                  </span>
                  <RelativeTime iso={message.created_at} />
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-[13.5px] ${
                      state.unread ? "text-fg" : "text-muted"
                    }`}
                  >
                    {state.snippet}
                  </span>
                  {state.unread ? (
                    // aria-label on a plain <span> isn't announced — the dot is
                    // decorative (aria-hidden) and sr-only text names the state.
                    <>
                      <span
                        aria-hidden
                        className={`size-2 shrink-0 rounded-full ${
                          state.undelivered || message.status === "draft_failed"
                            ? "bg-danger"
                            : "bg-accent-solid"
                        }`}
                      />
                      <span className="sr-only">Unread</span>
                    </>
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

/**
 * Collapsed conversation rail — the avatar-only mode the list snaps to when the
 * resize handle is dragged narrow (Apple Messages' icon rail). Each buyer is a
 * circular monogram with the active ring + unread dot preserved; the full label
 * rides in a native tooltip so nothing is lost. Desktop-only by construction
 * (the rail width only applies at lg).
 */
export function ConversationRail({
  inbound,
  repliesByQuestion,
  busy,
  itemLabels,
  selectedId,
  onSelect,
}: ConversationListProps) {
  return (
    <ul className="flex flex-col items-center gap-1.5 py-2">
      {inbound.map((message) => {
        const state = deriveConversationState(message, repliesByQuestion, busy);
        const active = message.id === selectedId;
        const label = buyerLabel(itemLabels, message);
        return (
          <li key={message.id}>
            {/* Circular avatar, rectangular hit/highlight area (owner): the
                active/hover state is a rounded-rect fill behind the circle. */}
            <button
              type="button"
              onClick={() => onSelect(message.id)}
              aria-current={active ? "true" : undefined}
              // The unread dot is purely visual here; fold the state into the
              // accessible name so the rail reads it out too.
              aria-label={state.unread ? `${label} (unread)` : label}
              title={label}
              className={`relative flex items-center justify-center rounded-xl p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                active ? "bg-surface-3" : "hover:bg-surface-2"
              }`}
            >
              <span className="relative">
                <BuyerAvatar name={label} className="size-10 text-[16px]" />
                {state.unread ? (
                  <span
                    aria-hidden
                    className={`absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-surface ${
                      state.undelivered || message.status === "draft_failed"
                        ? "bg-danger"
                        : "bg-accent-solid"
                    }`}
                  />
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────────────────── follow-up composer (post-reply) ─────────────────── */

/** A locally-previewed image attachment (object URL — front-end only in v1). */
interface PendingAttachment {
  id: string;
  url: string;
  name: string;
}

/**
 * Apple-Messages-style follow-up composer: a `+` attach button (a filled circle
 * at rest) opens a small popover (Photo library / Take a photo); to its right a
 * single rounded-full input pill takes the remaining width with the send control
 * tucked INSIDE at its right edge — an up-arrow (↑) circle that animates in only
 * once there's something to send. The `+`, the pill, and the send arrow all sit
 * on one vertical center axis.
 *
 * v1 SCOPE (honest): the picker + thumbnail previews are fully functional
 * front-end affordances, but **photos are preview-only** — actually delivering
 * image attachments to the buyer is a backend slice (Storage upload + a
 * message-attachments model + provider-hosted media). Text delivery is real
 * through the marketplace adapter. A faint
 * note appears while photos are attached so the seller is never misled.
 */
function FollowUpComposer({
  message,
  value,
  busy,
  onChange,
  onSend,
}: {
  message: MessageRow;
  value: string;
  busy: string | null;
  onChange: (id: string, value: string) => void;
  onSend: (message: MessageRow) => void;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  const text = value.trim();
  const sending = busy === `followup:${message.id}`;
  // Send requires TYPED TEXT. Photos are preview-only in this slice (real
  // attachment delivery arrives with the eBay adapter), and the typed text is the
  // only thing that actually sends — both the `sendFollowUp` handler and the
  // follow-up API bail on an empty body. Enabling send on a photo alone would
  // light up an actionable ↑ arrow that silently does nothing (Codex P2), so gate
  // it on text; the preview note already tells the seller the typed message sends.
  const canSend = text !== "";

  // Revoke object URLs on unmount so previews don't leak memory. A ref mirrors
  // the latest attachments so the unmount cleanup sees the CURRENT set — a
  // []-deps cleanup closes over the initial empty array and would revoke nothing,
  // leaking the blob URLs for the session when a seller leaves the inbox/thread
  // with photos still attached (Codex P3). Per-photo removal already revokes in
  // removeAttachment; this covers the leave-without-removing path.
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
    };
  }, []);

  function addFiles(files: FileList | null) {
    if (!files) return;
    const next = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => ({
        id: `${f.name}-${f.size}-${f.lastModified}`,
        url: URL.createObjectURL(f),
        name: f.name,
      }));
    setAttachments((prev) => [...prev, ...next]);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((a) => a.id !== id);
    });
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* attached-photo previews — removable thumbnails */}
      {attachments.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="relative size-16 overflow-hidden rounded-xl border border-border bg-surface-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.name} className="size-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-night/70 text-[13px] font-bold leading-none text-white transition-opacity hover:opacity-90"
                >
                  <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <p className="text-[12px] leading-snug text-faint">
            Photos preview here — sending them to the buyer arrives with the eBay
            adapter. Your typed message sends now.
          </p>
        </>
      ) : null}

      {/* One center axis: + circle · input pill (send tucked inside) */}
      <div className="flex items-center gap-2">
        {/* ── + attach button + popover (Apple Messages style) — filled circle
            at rest, not a hover-only background ── */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Add photos"
            aria-expanded={menuOpen}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-surface text-muted transition-colors hover:bg-surface-3 hover:text-fg-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {menuOpen ? (
            <>
              {/* click-away backdrop */}
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMenuOpen(false)}
                aria-hidden
              />
              <div
                role="menu"
                className="palette-pop absolute bottom-full -left-1 z-40 mb-3 w-44 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    libraryRef.current?.click();
                    setMenuOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-fg transition-colors hover:bg-surface-2"
                >
                  <svg viewBox="0 0 24 24" className="size-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 20" />
                  </svg>
                  Photo library
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    cameraRef.current?.click();
                    setMenuOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-fg transition-colors hover:bg-surface-2"
                >
                  <svg viewBox="0 0 24 24" className="size-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                    <circle cx="12" cy="13" r="3" />
                  </svg>
                  Take a photo
                </button>
              </div>
            </>
          ) : null}
          {/* hidden file inputs — reset value each time so re-picking the same
              file still fires onChange */}
          <input
            ref={libraryRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {/* ── input pill with the send control tucked inside its right edge.
            `pr-12` keeps text from sliding under the ↑ circle. ── */}
        <div className="relative min-w-0 flex-1">
          <textarea
            id={`followup-${message.id}`}
            aria-label="Send a follow-up message"
            value={value}
            onChange={(e) => onChange(message.id, e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline (chat convention).
              if (e.key === "Enter" && !e.shiftKey && canSend) {
                e.preventDefault();
                onSend(message);
              }
            }}
            rows={1}
            placeholder="Send a follow-up message…"
            className="block max-h-32 min-h-[2.25rem] w-full resize-none rounded-full border border-border bg-surface py-2 pl-4 pr-12 text-[15px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent/30"
          />

          {/* ↑ send — Apple style, fades+scales in only when there's something
              to send; reduced-motion gets an instant show/hide (no animation). */}
          <AnimatePresence initial={false}>
            {canSend ? (
              <motion.button
                key="send"
                type="button"
                onClick={() => onSend(message)}
                disabled={sending}
                aria-label="Send follow-up"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
                // Clear hover/press feedback (the bg shift alone was too subtle):
                // framer drives the scale (it owns transform, so CSS scale would
                // fight the mount animation); CSS handles the bg + shadow lift.
                whileHover={reduceMotion ? undefined : { scale: 1.08 }}
                whileTap={reduceMotion ? undefined : { scale: 0.94 }}
                // 7px = (pill 42 − button 28) / 2 → equal top/bottom/right margin,
                // so the circle is dead-centered vertically and nested symmetrically
                // in the pill's right cap (not crowding one edge).
                className="group absolute bottom-[7px] right-[7px] flex size-7 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-fg shadow-sm transition-[background-color,box-shadow] duration-150 ease-out hover:bg-primary-hover hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
              >
                {sending ? (
                  <span
                    aria-hidden
                    className="size-3 animate-spin rounded-full border-2 border-primary-fg/40 border-t-primary-fg motion-reduce:animate-none"
                  />
                ) : (
                  <svg viewBox="0 0 24 24" className="size-4 transition-transform duration-150 ease-out group-hover:-translate-y-px motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                )}
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── right pane: the thread ────────────────────────── */

export interface ConversationThreadProps {
  state: ConversationState;
  buyerName: string;
  /** Seller edits keyed by message id; absent → show the agent's draft as-is. */
  edits: Record<string, string>;
  busy: string | null;
  /** Follow-up outbound messages in this thread, oldest→newest (after the reply). */
  followUps: MessageRow[];
  /** The current follow-up composer text for this conversation. */
  followUpValue: string;
  onEdit: (id: string, value: string) => void;
  onApproveAndSend: (message: MessageRow) => void;
  onRetryDelivery: (message: MessageRow) => void;
  onRetryFollowUp: (message: MessageRow) => void;
  onRetryDraft: (message: MessageRow) => void;
  /** Composer input change + send for follow-up messages (post-reply). */
  onFollowUpChange: (id: string, value: string) => void;
  onSendFollowUp: (message: MessageRow) => void;
  /** Mobile only — return to the list pane. */
  onBack?: () => void;
}

export function ConversationThread({
  state,
  buyerName,
  edits,
  busy,
  followUps,
  followUpValue,
  onEdit,
  onApproveAndSend,
  onRetryDelivery,
  onRetryFollowUp,
  onRetryDraft,
  onFollowUpChange,
  onSendFollowUp,
  onBack,
}: ConversationThreadProps) {
  const {
    message,
    sentReply,
    delivered,
    sending,
    undelivered,
    canRetryFollowUps,
  } = state;
  const draftValue = edits[message.id] ?? message.draft_reply ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── thread header — LEFT-ALIGNED row (back · avatar · name), the
          two-pane-messenger convention (Gmail, Slack, Linear, Intercom). The old
          centered stack created a phantom center axis under the global header
          search: the search centers over the whole content area, but a centered
          thread header centers over only the right pane (content − list − handle),
          so the two never lined up and the identity read as off-center. A
          left-aligned header has no competing center, so nothing is misaligned.
          Fixed h-[72px] to line up with the conversation-list header beside it. ── */}
      <header className="flex h-[72px] shrink-0 items-center gap-3 bg-surface-2 px-3 sm:px-4">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-3 hover:text-fg-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 lg:hidden"
            aria-label="Back to conversations"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        ) : null}
        <BuyerAvatar name={buyerName} />
        <p className="min-w-0 truncate text-[15px] font-semibold leading-tight text-fg-strong">
          {buyerName}
        </p>
      </header>

      {/* ── message history (scrolls). bg-surface so the iMessage bubble tails
          (which cut out the thread background) blend seamlessly. Bubbles attach
          to the section's own edges (no centered max-width column), so inbound
          hugs the left and outbound the right — like iMessage. ── */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface px-4 py-5 sm:px-5">
        <div className="flex flex-col gap-3">
          {/* inbound buyer bubble — gray, tail bottom-left. The sr-only speaker
              label gives screen readers the attribution the left/right bubble
              alignment carries visually (audit). */}
          <div className="flex flex-col items-start gap-1">
            <div className="msg-bubble msg-in msg-enter max-w-[80%]">
              <p className="whitespace-pre-wrap">
                <span className="sr-only">Buyer: </span>
                {message.body}
              </p>
            </div>
            <RelativeTime iso={message.created_at} className="px-1" />
          </div>

          {/* outbound — your delivered reply: green bubble, tail bottom-right */}
          {delivered ? (
            <div className="flex flex-col items-end gap-1">
              <div
                className="msg-bubble msg-out msg-enter max-w-[80%]"
                style={{ animationDelay: "80ms" }}
              >
                <p className="whitespace-pre-wrap">
                  <span className="sr-only">You: </span>
                  {sentReply?.body ?? message.draft_reply}
                </p>
              </div>
              <span className="flex items-center gap-1 px-1 text-[11px] text-faint">
                <svg viewBox="0 0 24 24" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {messagePolicyEvidenceLabel(message) ?? "Delivered"}
              </span>
            </div>
          ) : null}

          {/* Persist every seller-authored intent, including a rejected, failed,
              or ambiguous delivery. Unconfirmed attempts stay visible and
              retryable instead of being presented as delivered. */}
          {followUps.map((m) => {
            const delivered = m.delivery_status === "delivered";
            const retrying = busy === `retry-followup:${m.id}`;
            return (
            <div key={m.id} className="flex flex-col items-end gap-1">
              <div
                className={`msg-bubble msg-enter max-w-[80%] ${
                  delivered
                    ? "msg-out"
                    : "border border-danger-border bg-danger-soft text-danger-soft-fg"
                }`}
              >
                <p className="whitespace-pre-wrap">
                  <span className="sr-only">You: </span>
                  {m.body}
                </p>
              </div>
              {delivered ? (
                <span className="flex items-center gap-1 px-1 text-[11px] text-faint">
                  <svg viewBox="0 0 24 24" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Delivered
                </span>
              ) : (
                <span className="flex items-center gap-2 px-1 text-[11px] text-danger-soft-fg">
                  {deliveryRecoveryLabel(
                    m.delivery_status,
                    m.delivery_attempted_at,
                  )}
                  {canRetryFollowUps ? (
                    <button
                      type="button"
                      onClick={() => onRetryFollowUp(m)}
                      disabled={!canRetryDelivery(m.delivery_status, retrying)}
                      className="font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                    >
                      {retrying ? "Retrying…" : "Retry"}
                    </button>
                  ) : null}
                </span>
              )}
            </div>
            );
          })}
        </div>
      </div>

      {/* ── composer / recovery dock (pinned) ── */}
      <div className="bg-surface-2 px-4 py-4 sm:px-5">
        {message.status === "externally_answered" ? (
          <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <p className="text-[13px] font-semibold text-muted">
              Answered on eBay
            </p>
            <p className="mt-1 text-[13px] text-faint">
              This question is no longer awaiting a reply.
            </p>
          </div>
        ) : message.status === "provider_unavailable" ? (
          <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <p className="text-[13px] font-semibold text-muted">
              No longer active on eBay
            </p>
            <p className="mt-1 text-[13px] text-faint">
              eBay no longer reports this question as active, so SnapList cannot safely reply to it.
            </p>
          </div>
        ) : undelivered ? (
          <div className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-soft px-3.5 py-3">
            <p className="text-[12.5px] font-semibold text-danger-soft-fg">
              {requiresDuplicateRiskConfirmation(
                message.delivery_status,
                message.delivery_attempted_at,
              )
                ? "Delivery unconfirmed. eBay may already have received this reply."
                : message.delivery_status === "sending"
                  ? "Delivery pending. Retry is available if the send lease expired."
                  : canonicalReplyFailureLabel(message)}
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
        ) : sending ? (
          <p className="flex items-center justify-center gap-1.5 py-1 text-[13px] text-faint">
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-faint motion-reduce:animate-none"
            />
            Sending your reply…
          </p>
        ) : message.status === "sent" ? (
          // Replied — but the conversation stays open: the seller can send
          // follow-up messages (free text + photo attachments). The composer
          // mirrors Apple Messages — `+` attach at the left, compact send at the
          // right. (Photo *delivery* is the next backend slice; see FollowUpComposer.)
          <FollowUpComposer
            message={message}
            value={followUpValue}
            busy={busy}
            onChange={onFollowUpChange}
            onSend={onSendFollowUp}
          />
        ) : message.status === "drafted" ? (
          <div className="flex flex-col gap-2.5">
            <div className="rounded-lg border border-brand-tint bg-brand-soft px-3.5 py-3">
              <label
                htmlFor={`reply-${message.id}`}
                className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-semibold text-accent-soft-fg"
              >
                <SparkleIcon className="size-3 shrink-0" />
                {message.policy_delivery_status === "blocked"
                  ? "Automatic send blocked · review before sending"
                  : message.policy_outcome === "escalate"
                  ? "Needs seller check · review before sending"
                  : message.policy_outcome === "draft_for_approval"
                    ? "Needs your approval · edit before sending"
                    : "Automatic reply queued · verifying current eBay state"}
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
                {message.policy_outcome === "auto_send" &&
                message.policy_delivery_status === "not_attempted"
                  ? "Sends automatically after a final safety check"
                  : "Nothing sends until you approve"}
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

/** Calm middle state — shown when no conversation is picked. With the page
 *  title strip gone, this is where the "what this is / how it works" copy
 *  lives, so a first visit explains the inbox before anything is selected. */
export function ThreadPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <span
        aria-hidden
        className="flex size-16 items-center justify-center rounded-2xl bg-brand-soft text-accent-soft-fg"
      >
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <h2 className="mt-5 font-display text-[21px] font-bold tracking-tight text-fg-strong">
        Your buyer inbox
      </h2>
      <p className="mt-2.5 max-w-sm text-[15px] leading-relaxed text-muted">
        Buyer questions land here live. We draft a reply from the listing, then
        you approve or edit it before anything sends. Pick a conversation on the
        left to get started.
      </p>
    </div>
  );
}

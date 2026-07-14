"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { notFound } from "next/navigation";
import { useListResize } from "@/app/(app)/inbox/use-list-resize";
import { InboxEmptyState } from "@/app/(app)/inbox/inbox-empty";
import { SimulatorCard } from "@/app/(app)/inbox/simulator-card";
import {
  ConversationList,
  ConversationRail,
  ConversationThread,
  ThreadPlaceholder,
  deriveConversationState,
  useIsDesktopPane,
} from "@/app/(app)/inbox/conversation-list";
import { SimulatorMenu, type ItemOption } from "@/app/(app)/inbox/inbox-client";
import type { MessageRow } from "@/lib/inbox";

/**
 * DEV-ONLY inbox preview (/dev/preview/inbox-live — a static sibling of the
 * [screen] harness, proxy-whitelisted under /dev). The real /inbox needs a
 * running Supabase stack (Realtime + RLS reads); this renders the SAME two-pane
 * messaging surface — list pane (with the folded simulator), the selected
 * thread, and the calm placeholder / empty state — from fixtures, so the screen
 * can be screenshot-iterated like the /dev/preview harness. Hard-gated out of
 * production builds.
 *
 * The fixtures span FOUR realistic conversations across distinct items and
 * exercise every reply state the live inbox can show: drafted (editable
 * composer), replied (sent), drafting (in-flight), and the not-delivered
 * recovery path — so the redesign can be reviewed against the Shopify
 * conversation-list / message-thread references without live data.
 */

// Distinct item ids per conversation so each row names a different listing,
// matching how the live inbox maps message.item_id → the item's label.
const ITEM_PS5 = "00000000-0000-0000-0000-0000000000a1";
const ITEM_SWITCH = "00000000-0000-0000-0000-0000000000a2";
const ITEM_CAMERA = "00000000-0000-0000-0000-0000000000a3";
const ITEM_IPHONE = "00000000-0000-0000-0000-0000000000a4";

const FIXTURE_ITEMS: ItemOption[] = [
  { id: ITEM_PS5, label: "Sony PlayStation 5 bundle" },
  { id: ITEM_SWITCH, label: "Nintendo Switch 2" },
  { id: ITEM_CAMERA, label: "Sony mirrorless camera kit" },
  { id: ITEM_IPHONE, label: "Apple iPhone 15" },
];

// Fixed base (not Date.now()) so the <time dateTime> ISO strings are identical
// on the server render and the client hydration — Date.now() is evaluated once
// per environment and the ~ms drift caused a hydration mismatch in this preview.
// The real inbox uses stable DB timestamps, so it never had this issue.
const NOW = Date.parse("2026-06-16T15:10:00.000Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** A buyer question row, leaving threading/replies to the maps below. */
function inbound(
  id: string,
  itemId: string,
  body: string,
  status: MessageRow["status"],
  createdMinsAgo: number,
  extra: Partial<MessageRow> = {},
): MessageRow {
  return {
    id,
    user_id: "preview",
    item_id: itemId,
    listing_id: null,
    direction: "inbound",
    body,
    draft_reply: null,
    status,
    sent_at: null,
    reply_to: null,
    draft_model: null,
    created_at: minsAgo(createdMinsAgo),
    updated_at: minsAgo(createdMinsAgo),
    ...extra,
  };
}

function outbound(
  id: string,
  itemId: string,
  replyTo: string,
  body: string,
  sentMinsAgo: number,
  replyKind: "reply" | "followup" = "reply",
): MessageRow {
  return {
    id,
    user_id: "preview",
    item_id: itemId,
    listing_id: null,
    direction: "outbound",
    body,
    draft_reply: null,
    status: "sent",
    sent_at: minsAgo(sentMinsAgo),
    reply_to: replyTo,
    reply_kind: replyKind,
    draft_model: null,
    created_at: minsAgo(sentMinsAgo),
    updated_at: minsAgo(sentMinsAgo),
  };
}

const Q_DRAFTED = "00000000-0000-0000-0000-0000000000d1";
const Q_SENT = "00000000-0000-0000-0000-0000000000d2";
const Q_DRAFTING = "00000000-0000-0000-0000-0000000000d3";
const Q_UNDELIVERED = "00000000-0000-0000-0000-0000000000d4";

const FIXTURE_INBOUND: MessageRow[] = [
  inbound(
    Q_DRAFTED,
    ITEM_PS5,
    "Hi! Does the DualSense controller pictured come with the console?",
    "drafted",
    3,
    {
      draft_reply:
        "Yes — the white DualSense controller shown in the photo is included with the PlayStation 5 console.",
      draft_model: "gpt-4o-mini",
    },
  ),
  inbound(
    Q_DRAFTING,
    ITEM_SWITCH,
    "Are the Joy-Con controllers shown attached to the Switch 2 included?",
    "new",
    1,
  ),
  inbound(
    Q_SENT,
    ITEM_CAMERA,
    "Are all three lenses shown included with the Sony camera body?",
    "sent",
    22,
    { sent_at: minsAgo(18) },
  ),
  inbound(
    Q_UNDELIVERED,
    ITEM_IPHONE,
    "Can you do $440 if I pick up the iPhone locally this week?",
    "sent",
    48,
    {
      draft_reply:
        "I can meet at $465 for a local pickup this week — that already reflects a fair discount off the listed price.",
    },
  ),
];

const FIXTURE_REPLIES = new Map<string, MessageRow>([
  [
    Q_SENT,
    outbound(
      "00000000-0000-0000-0000-0000000000e2",
      ITEM_CAMERA,
      Q_SENT,
      "Yes — the Sony camera body and all three lenses shown in the listing photo are included as one kit.",
      18,
    ),
  ],
]);

// Follow-up messages the seller sent AFTER the first reply — the thread stays
// open (a conversation, not a single Q&A pair), so the persistent composer shows.
const FIXTURE_FOLLOWUPS = new Map<string, MessageRow[]>([
  [
    Q_SENT,
    [
      outbound(
        "00000000-0000-0000-0000-0000000000f1",
        ITEM_CAMERA,
        Q_SENT,
        "I can also send close-ups of each lens mount before you decide.",
        12,
        "followup",
      ),
      outbound(
        "00000000-0000-0000-0000-0000000000f2",
        ITEM_CAMERA,
        Q_SENT,
        "The listing photo shows the exact camera body and three lenses included in this kit.",
        10,
        "followup",
      ),
    ],
  ],
]);

export default function InboxDevPreviewPage() {
  const [selectedItem, setSelectedItem] = useState(FIXTURE_ITEMS[0].id);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(Q_DRAFTED);
  const [view, setView] = useState<"populated" | "empty">("populated");

  // Resizable conversation list — same hook as the shipped inbox (drag narrow
  // → snaps to the avatar-only rail).
  const { width: listWidth, collapsed, dragging, handleProps } = useListResize();
  // Same single-pane (mobile) vs two-pane (desktop) fork as the live inbox.
  const isDesktop = useIsDesktopPane();
  const reduceMotion = useReducedMotion();

  if (process.env.NODE_ENV === "production") notFound();

  const inboundRows = FIXTURE_INBOUND;
  const itemLabels = new Map(FIXTURE_ITEMS.map((i) => [i.id, i.label] as const));
  const buyerLabelFor = (m: MessageRow) =>
    (m.item_id ? itemLabels.get(m.item_id) : undefined) ?? "Buyer question";

  const selectedMessage =
    view === "populated" && selectedId
      ? inboundRows.find((m) => m.id === selectedId) ?? null
      : null;
  const unreadCount = inboundRows.reduce((n, m) => {
    const replied = m.status === "sent" && FIXTURE_REPLIES.has(m.id);
    return replied ? n : n + 1;
  }, 0);

  // One thread instance, reused by whichever layout is live (see inbox-client).
  const conversationThread = selectedMessage ? (
    <ConversationThread
      state={deriveConversationState(selectedMessage, FIXTURE_REPLIES, null)}
      buyerName={buyerLabelFor(selectedMessage)}
      edits={edits}
      busy={null}
      followUps={FIXTURE_FOLLOWUPS.get(selectedMessage.id) ?? []}
      attachments={[]}
      followUpValue={followUpDrafts[selectedMessage.id] ?? ""}
      onEdit={(id, value) => setEdits((prev) => ({ ...prev, [id]: value }))}
      onApproveAndSend={async () => true}
      onRetryDelivery={() => {}}
      onRetryFollowUp={() => {}}
      onRetryDraft={() => {}}
      onFollowUpChange={(id, value) =>
        setFollowUpDrafts((prev) => ({ ...prev, [id]: value }))
      }
      onSendFollowUp={async () => true}
      onBack={() => setSelectedId(null)}
    />
  ) : null;

  return (
    <main className="relative flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] w-full flex-col overflow-hidden sm:h-[calc(100dvh-72px)]">
      {/* dev-only view switch — floated over the surface (the shipped /inbox has
          no title strip; this preview matches it). Not part of the screen. */}
      <div
        data-preview-controls
        className="absolute right-4 top-3 z-20 hidden overflow-hidden rounded-lg border border-border text-[13px] font-medium shadow-sm sm:flex"
      >
        {(["populated", "empty"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`px-3 py-1.5 capitalize transition-colors ${
              view === v
                ? "bg-primary text-primary-fg"
                : "bg-surface text-muted hover:text-fg-strong"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {view === "empty" ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6">
          <SimulatorCard
            items={FIXTURE_ITEMS}
            selectedItem={selectedItem}
            onSelectItem={setSelectedItem}
            onSimulate={() => {}}
            connection="live"
            simulating={false}
          />
          <InboxEmptyState />
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          style={{ "--inbox-list-w": `${listWidth}px` } as React.CSSProperties}
          className={`relative flex min-h-[60vh] flex-1 overflow-hidden bg-surface lg:min-h-0 ${
            dragging ? "select-none" : ""
          }`}
        >
          {/* ── left: conversation list (resizable on desktop) ── */}
          <nav
            aria-label="Buyer conversations"
            className={`flex min-h-0 w-full flex-col border-border lg:w-[var(--inbox-list-w)] lg:shrink-0 ${
              dragging ? "" : "lg:transition-[width] lg:duration-200 lg:ease-out"
            }`}
          >
            {/* full header — mobile always; desktop when expanded */}
            <header
              className={`flex h-[72px] items-center justify-between gap-2 bg-surface-2 px-4 ${
                collapsed ? "lg:hidden" : ""
              }`}
            >
              <span className="flex items-baseline gap-2">
                <h2 className="text-[14px] font-semibold text-fg-strong">
                  Conversations
                </h2>
                {unreadCount > 0 ? (
                  <span
                    data-nums
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-soft-fg"
                  >
                    {unreadCount} new
                  </span>
                ) : null}
              </span>
              <SimulatorMenu
                items={FIXTURE_ITEMS}
                selectedItem={selectedItem}
                onSelectItem={setSelectedItem}
                onSimulate={() => {}}
                connection="live"
                simulating={false}
              />
            </header>
            {/* collapsed header — desktop rail only: just the simulate trigger */}
            <div
              className={`hidden h-[72px] items-center justify-center bg-surface-2 ${
                collapsed ? "lg:flex" : ""
              }`}
            >
              <SimulatorMenu
                compact
                items={FIXTURE_ITEMS}
                selectedItem={selectedItem}
                onSelectItem={setSelectedItem}
                onSimulate={() => {}}
                connection="live"
                simulating={false}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* full list — mobile always; desktop when expanded */}
              <div className={collapsed ? "lg:hidden" : ""}>
                <ConversationList
                  inbound={inboundRows}
                  repliesByQuestion={FIXTURE_REPLIES}
                  busy={null}
                  itemLabels={itemLabels}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
              {/* collapsed avatar rail — desktop only */}
              {collapsed ? (
                <div className="hidden lg:block">
                  <ConversationRail
                    inbound={inboundRows}
                    repliesByQuestion={FIXTURE_REPLIES}
                    busy={null}
                    itemLabels={itemLabels}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
              ) : null}
            </div>
          </nav>

          {/* ── drag handle: resize the conversation list (desktop only) ── */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize conversation list"
            {...handleProps}
            className="group relative hidden w-1.5 shrink-0 cursor-col-resize touch-none lg:block"
          >
            <span
              aria-hidden
              className={`absolute inset-y-0 left-1/2 -translate-x-1/2 transition-all ${
                dragging
                  ? "w-[2px] bg-accent"
                  : "w-px bg-border group-hover:w-[2px] group-hover:bg-accent/60"
              }`}
            />
          </div>

          {/* ── right: selected thread / placeholder (desktop static pane) ── */}
          <section
            aria-label="Conversation"
            className="hidden min-h-0 flex-1 flex-col lg:flex"
          >
            {isDesktop ? conversationThread ?? <ThreadPlaceholder /> : null}
          </section>

          {/* ── mobile slide-over (mirrors inbox-client): thread pushes in from
              the right, slides back out on Back. Mounted only below `lg`. ── */}
          <AnimatePresence initial={false}>
            {!isDesktop && selectedMessage ? (
              <motion.section
                key="mobile-thread"
                aria-label="Conversation"
                className="absolute inset-0 z-20 flex min-h-0 flex-col bg-surface lg:hidden"
                initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
                animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
                transition={
                  reduceMotion
                    ? { duration: 0.15 }
                    : { type: "tween", duration: 0.28, ease: [0.22, 1, 0.36, 1] }
                }
              >
                {conversationThread}
              </motion.section>
            ) : null}
          </AnimatePresence>
        </motion.div>
      )}
    </main>
  );
}

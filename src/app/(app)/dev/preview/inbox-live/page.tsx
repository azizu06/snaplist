"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { InboxEmptyState } from "@/app/(app)/inbox/inbox-empty";
import { SimulatorCard } from "@/app/(app)/inbox/simulator-card";
import {
  ConversationList,
  ConversationThread,
  ThreadPlaceholder,
  deriveConversationState,
} from "@/app/(app)/inbox/conversation-list";
import type { ItemOption } from "@/app/(app)/inbox/inbox-client";
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
const ITEM_XM4 = "00000000-0000-0000-0000-0000000000a1";
const ITEM_LEGO = "00000000-0000-0000-0000-0000000000a2";
const ITEM_PATAGONIA = "00000000-0000-0000-0000-0000000000a3";
const ITEM_KINDLE = "00000000-0000-0000-0000-0000000000a4";

const FIXTURE_ITEMS: ItemOption[] = [
  { id: ITEM_XM4, label: "Sony WH-1000XM4 Headphones" },
  { id: ITEM_LEGO, label: "LEGO Millennium Falcon 75257" },
  { id: ITEM_PATAGONIA, label: "Patagonia Better Sweater (M)" },
  { id: ITEM_KINDLE, label: "Kindle Paperwhite 11th Gen" },
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
    ITEM_XM4,
    "Hi! Does it come with the original box and both charging cables?",
    "drafted",
    3,
    {
      draft_reply:
        "Yes — it ships in the original box with both the USB-C and 3.5mm cables included. Everything is pictured in the listing.",
      draft_model: "gpt-4o-mini",
    },
  ),
  inbound(
    Q_DRAFTING,
    ITEM_LEGO,
    "Is the build complete with all minifigures and the instruction booklet?",
    "new",
    1,
  ),
  inbound(
    Q_SENT,
    ITEM_PATAGONIA,
    "Is this still available? Any pilling or stains on the sweater?",
    "sent",
    22,
    { sent_at: minsAgo(18) },
  ),
  inbound(
    Q_UNDELIVERED,
    ITEM_KINDLE,
    "Can you do $75 if I pick it up locally this week?",
    "sent",
    48,
    {
      draft_reply:
        "I can meet at $85 for a local pickup this week — that already reflects a fair discount off the listed price.",
    },
  ),
];

const FIXTURE_REPLIES = new Map<string, MessageRow>([
  [
    Q_SENT,
    outbound(
      "00000000-0000-0000-0000-0000000000e2",
      ITEM_PATAGONIA,
      Q_SENT,
      "Yes, it's still available. No stains and only very light pilling under the arms — the photos show every angle in natural light.",
      18,
    ),
  ],
]);

export default function InboxDevPreviewPage() {
  const [selectedItem, setSelectedItem] = useState(FIXTURE_ITEMS[0].id);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(Q_DRAFTED);
  const [view, setView] = useState<"populated" | "empty">("populated");
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

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight text-fg-strong">
            Buyer inbox
          </h1>
          <p className="mt-1 max-w-2xl text-[15px] leading-relaxed text-muted">
            Questions from buyers land here live. We draft a reply from the
            listing, then you approve or edit before anything sends.
          </p>
        </div>
        {/* dev-only view switch — not part of the shipped screen */}
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-border text-[13px] font-medium">
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
      </header>

      {view === "empty" ? (
        <div className="flex flex-col gap-6">
          <SimulatorCard
            items={FIXTURE_ITEMS}
            selectedItem={selectedItem}
            onSelectItem={setSelectedItem}
            onSimulate={() => {}}
            live
            simulating={false}
          />
          <InboxEmptyState />
        </div>
      ) : (
        <div className="flex min-h-[60vh] overflow-hidden rounded-xl border border-border bg-surface shadow-xs lg:h-[calc(100vh-13rem)] lg:min-h-[34rem]">
          {/* ── left: conversation list ── */}
          <nav
            aria-label="Buyer conversations"
            className={`min-h-0 w-full flex-col border-border lg:flex lg:w-[340px] lg:shrink-0 lg:border-r ${
              selectedMessage ? "hidden lg:flex" : "flex"
            }`}
          >
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
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
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
              >
                <svg viewBox="0 0 24 24" className="size-3.5 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 2v6.3L4.6 17.4A2 2 0 0 0 6.3 20.5h11.4a2 2 0 0 0 1.7-3.1L14 8.3V2" />
                  <path d="M8.5 2h7" />
                </svg>
                Simulate
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ConversationList
                inbound={inboundRows}
                repliesByQuestion={FIXTURE_REPLIES}
                busy={null}
                itemLabels={itemLabels}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
          </nav>

          {/* ── right: selected thread / placeholder ── */}
          <section
            aria-label="Conversation"
            className={`min-h-0 flex-1 flex-col ${selectedMessage ? "flex" : "hidden lg:flex"}`}
          >
            {selectedMessage ? (
              <ConversationThread
                state={deriveConversationState(
                  selectedMessage,
                  FIXTURE_REPLIES,
                  null,
                )}
                buyerName={buyerLabelFor(selectedMessage)}
                edits={edits}
                busy={null}
                onEdit={(id, value) =>
                  setEdits((prev) => ({ ...prev, [id]: value }))
                }
                onApproveAndSend={() => {}}
                onRetryDelivery={() => {}}
                onRetryDraft={() => {}}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <ThreadPlaceholder />
            )}
          </section>
        </div>
      )}
    </main>
  );
}

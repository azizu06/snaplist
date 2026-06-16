"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { InboxEmptyState } from "@/app/(app)/inbox/inbox-empty";
import { SimulatorCard } from "@/app/(app)/inbox/simulator-card";
import { ConversationList } from "@/app/(app)/inbox/conversation-list";
import type { ItemOption } from "@/app/(app)/inbox/inbox-client";
import type { MessageRow } from "@/lib/inbox";

/**
 * DEV-ONLY inbox preview (/dev/preview/inbox-live — a static sibling of the
 * [screen] harness, proxy-whitelisted under /dev). The real /inbox needs a
 * running Supabase stack (Realtime + RLS reads); this renders the SAME surface
 * composition — header, simulator card, and the populated conversation list (or
 * the empty state) — from fixtures so the screen can be screenshot-iterated like
 * the /dev/preview harness. Hard-gated out of production builds.
 *
 * It exercises every reply state the live inbox can show: drafted (editable
 * composer), replied (sent), drafting (in-flight), and the not-delivered
 * recovery path — so the redesign can be reviewed against the Shopify
 * order-timeline / Send-invoice references without live data.
 */

const FIXTURE_ITEMS: ItemOption[] = [
  { id: "fx-1", label: "Sony WH-1000XM4" },
  { id: "fx-2", label: "LEGO Millennium Falcon 75257" },
  { id: "fx-3", label: "Patagonia Better Sweater M" },
];

const NOW = Date.now();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** A buyer question row, leaving threading/replies to the maps below. */
function inbound(
  id: string,
  body: string,
  status: MessageRow["status"],
  createdMinsAgo: number,
  extra: Partial<MessageRow> = {},
): MessageRow {
  return {
    id,
    user_id: "preview",
    item_id: "00000000-0000-0000-0000-000000000001",
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

function outbound(id: string, replyTo: string, body: string): MessageRow {
  return {
    id,
    user_id: "preview",
    item_id: "00000000-0000-0000-0000-000000000001",
    listing_id: null,
    direction: "outbound",
    body,
    draft_reply: null,
    status: "sent",
    sent_at: minsAgo(2),
    reply_to: replyTo,
    draft_model: null,
    created_at: minsAgo(2),
    updated_at: minsAgo(2),
  };
}

const Q_DRAFTED = "00000000-0000-0000-0000-0000000000d1";
const Q_SENT = "00000000-0000-0000-0000-0000000000d2";
const Q_DRAFTING = "00000000-0000-0000-0000-0000000000d3";
const Q_UNDELIVERED = "00000000-0000-0000-0000-0000000000d4";

const FIXTURE_INBOUND: MessageRow[] = [
  inbound(
    Q_DRAFTED,
    "Hi! Does it come with the original box and both charging cables?",
    "drafted",
    3,
    {
      draft_reply:
        "Yes — it ships in the original box with both the USB-C and 3.5mm cables included. Everything is pictured in the listing.",
      draft_model: "gpt-4o-mini",
    },
  ),
  inbound(Q_SENT, "Is this still available? Any scratches on the ear cups?", "sent", 22, {
    sent_at: minsAgo(2),
  }),
  inbound(Q_DRAFTING, "Would you ship to Canada, and roughly what would postage run?", "new", 1),
  inbound(Q_UNDELIVERED, "Can you do $150 if I pick up locally this week?", "sent", 48, {
    draft_reply:
      "I can meet at $160 for a local pickup this week — that already reflects a fair discount off the listed price.",
  }),
];

const FIXTURE_REPLIES = new Map<string, MessageRow>([
  [
    Q_SENT,
    outbound(
      "00000000-0000-0000-0000-0000000000e2",
      Q_SENT,
      "Yes, it's still available. Light wear on the headband only — the ear cups are clean, and the photos show every angle.",
    ),
  ],
]);

export default function InboxDevPreviewPage() {
  const [selectedItem, setSelectedItem] = useState(FIXTURE_ITEMS[0].id);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [view, setView] = useState<"populated" | "empty">("populated");
  if (process.env.NODE_ENV === "production") notFound();

  const inboundRows = FIXTURE_INBOUND;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
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

      <div className="flex flex-col gap-6">
        <SimulatorCard
          items={FIXTURE_ITEMS}
          selectedItem={selectedItem}
          onSelectItem={setSelectedItem}
          onSimulate={() => {}}
          live
          simulating={false}
        />
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-fg-strong">Conversations</h2>
            {view === "populated" ? (
              <span
                data-nums
                className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"
              >
                {inboundRows.length}
              </span>
            ) : null}
          </div>
          {view === "empty" ? (
            <InboxEmptyState />
          ) : (
            <ConversationList
              inbound={inboundRows}
              repliesByQuestion={FIXTURE_REPLIES}
              edits={edits}
              busy={null}
              onEdit={(id, value) => setEdits((prev) => ({ ...prev, [id]: value }))}
              onApproveAndSend={() => {}}
              onRetryDelivery={() => {}}
              onRetryDraft={() => {}}
            />
          )}
        </section>
      </div>
    </main>
  );
}

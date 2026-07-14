"use client";

import { useState } from "react";
import {
  ConversationThread,
  deriveConversationState,
} from "@/app/(app)/inbox/conversation-list";
import type { MessageRow } from "@/lib/inbox";

/**
 * DEV-ONLY preview wrapper for the inbox thread (composer + header). The live
 * inbox needs Realtime + auth + Supabase, none of which the screenshot harness
 * has — so this renders the real <ConversationThread> with a fixture in the
 * "replied" state (which is the branch that mounts the follow-up composer) and
 * local state for the composer text. It exists so the composer / attach-menu /
 * header can be visually iterated headlessly. Hard-gated out of prod by the
 * preview route. Client component: ConversationThread takes event handlers,
 * which a Server Component can't pass.
 */

const INBOUND: MessageRow = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "preview-user",
  item_id: "00000000-0000-4000-8000-0000000000a1",
  listing_id: null,
  direction: "inbound",
  body: "Hi! Does the DualSense controller pictured come with the PlayStation 5?",
  draft_reply: "Yes — the white DualSense controller shown in the photo is included.",
  status: "sent",
  sent_at: "2026-06-18T03:00:00Z",
  reply_to: null,
  reply_kind: null,
  draft_model: "gemini-2.5-flash",
  created_at: "2026-06-18T02:58:00Z",
  updated_at: "2026-06-18T03:00:00Z",
};

const REPLY: MessageRow = {
  id: "00000000-0000-4000-8000-000000000002",
  user_id: "preview-user",
  item_id: INBOUND.item_id,
  listing_id: null,
  direction: "outbound",
  body: "Yes — the white DualSense controller shown in the photo is included.",
  draft_reply: null,
  status: "sent",
  sent_at: "2026-06-18T03:01:00Z",
  reply_to: INBOUND.id,
  reply_kind: "reply",
  draft_model: null,
  created_at: "2026-06-18T03:01:00Z",
  updated_at: "2026-06-18T03:01:00Z",
};

export function InboxThreadPreview() {
  // Seed with text so the send arrow is visible (it only appears once there's
  // something to send) — the exact case being visually verified.
  const [value, setValue] = useState(
    "Glad to help — let me know if you'd like more photos!",
  );
  const repliesByQuestion = new Map<string, MessageRow>([[INBOUND.id, REPLY]]);
  const state = deriveConversationState(INBOUND, repliesByQuestion, null);
  const noop = () => {};
  const succeed = async () => true;

  return (
    <div className="mx-auto flex h-[640px] w-full max-w-[760px] overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <ConversationThread
        state={state}
        buyerName="Sony PlayStation 5 bundle"
        edits={{}}
        busy={null}
        followUps={[]}
        attachments={[]}
        followUpValue={value}
        followUpComposerVersion={0}
        onEdit={noop}
        onApproveAndSend={succeed}
        onRetryDelivery={noop}
        onRetryFollowUp={noop}
        onRetryDraft={noop}
        onFollowUpChange={(_id, v) => setValue(v)}
        onSendFollowUp={succeed}
      />
    </div>
  );
}

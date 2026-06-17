-- Follow-up messages in a buyer conversation (issue #13, follow-up slice).
--
-- v1 modelled a conversation as ONE inbound question -> ONE outbound reply,
-- threaded via reply_to and deduped by the partial unique index
-- messages_reply_to_unique. That hard-blocked the seller from sending anything
-- after the first reply ("Replied — nothing further to send"), which is NOT how
-- eBay's member messaging works (AddMemberMessageRTQ / AddMemberMessagesAAQTo-
-- Bidder allow many seller messages per thread). This migration lets a seller
-- send any number of FOLLOW-UP messages after the first reply, while keeping the
-- canonical reply's idempotency backstop fully intact.
--
-- HOW: a `reply_kind` discriminator on outbound rows.
--   • canonical reply  -> reply_kind NULL (existing rows) or 'reply'
--   • follow-up message -> reply_kind 'followup'
-- Both thread to the conversation root via reply_to = <inbound question id>, so
-- the composite tenant FK (reply_to, user_id) -> messages(id, user_id) still
-- pins every follow-up to the owner's own question (no cross-tenant threading).
--
-- The unique index is NARROWED, not dropped: it still guarantees at most ONE
-- canonical reply per question (so approveAndSendReply's CAS claim and
-- retryReplyDelivery's crash-recovery stay correct), but places no constraint on
-- 'followup' rows. Existing outbound rows (reply_kind NULL) are still treated as
-- canonical and remain deduped — no data rewrite, no behavioural change for them.
--
-- Additive + idempotent: safe to re-run.

alter table public.messages
  add column if not exists reply_kind text;

-- Replace the all-replies unique index with a canonical-reply-only one. A
-- follow-up (reply_kind = 'followup') shares its conversation root's reply_to
-- value, so the old index would have rejected it as a duplicate; the narrowed
-- predicate excludes follow-ups while still collapsing any second CANONICAL
-- reply to a 23505 (the idempotent-conflict backstop the app relies on).
drop index if exists public.messages_reply_to_unique;

create unique index if not exists messages_canonical_reply_unique
  on public.messages (reply_to)
  where reply_to is not null and (reply_kind is null or reply_kind = 'reply');

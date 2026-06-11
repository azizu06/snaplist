-- Idempotency backstop for reply sends (PR #35 review, finding 2).
--
-- approveAndSendReply claims the inbound question via compare-and-set
-- (drafted -> sent) before delivering, then inserts the outbound reply row
-- threaded via reply_to. This partial unique index is the database-level
-- guarantee behind that flow: at most ONE outbound reply can ever exist per
-- inbound question, so a retry or concurrent request that slips past the CAS
-- surfaces as a unique violation (treated as an idempotent 409 conflict in the
-- app) instead of inserting a second reply.
--
-- Additive + idempotent: safe to re-run.
create unique index if not exists messages_reply_to_unique
  on public.messages (reply_to)
  where reply_to is not null;

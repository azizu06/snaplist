-- SnapList — persist the vision step's identification on the item (issue #27).
--
-- The vision pipeline (#6) produces an `identification` ("what we think it is" +
-- the model's ambiguity decision: confident flag, reason, candidates). Until now it
-- was discarded at persistence and the review page RE-DERIVED it from attributes
-- alone — which loses a model-flagged-ambiguous item that nevertheless has strong
-- identifiers, presenting an explicitly-uncertain id as confirmed. Surfaced by Codex
-- review on PR #26 (P1).
--
-- Store it as JSONB on `items` so the review page renders the model's actual decision.
-- Nullable: legacy rows and the stub pipeline have no identification. RLS on `items`
-- already gates every column by owner; no new policy needed.

alter table public.items
  add column if not exists identification jsonb;

comment on column public.items.identification is
  'Vision identification { label, confident, evidence, reason?, candidates? } — the surfaced "what we think it is" with the model''s ambiguity preserved. Null for legacy/stub rows.';

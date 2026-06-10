-- SnapList — multi-tenant data foundation (schema).
--
-- Non-negotiable #1 (AGENTS.md / PRD "Tenancy & data"): multi-tenant from day one.
-- Every domain table carries `user_id uuid` referencing `auth.users(id)`. RLS
-- (enabled in the companion policy migration) enforces per-user isolation. This
-- file only creates the schema; isolation lives in 20260610180100_rls_policies.sql.
--
-- The schema in the PRD is explicitly "conceptual, not final" — this migration is
-- the review-worthy realization of it.

-- pgvector: embeddings/corpus live in Postgres (PRD "RAG (pgvector)").
-- Supabase convention is to keep extensions out of `public`.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- Embedding dimensionality. OpenAI text-embedding-3-small = 1536 dims. The model
-- is swappable (AGENTS.md); 1536 is the documented default for the small model.
-- If a different embedding model is adopted, change this single constant.

-- =====================================================================
-- items — the root entity. A single physical thing the seller wants to sell.
-- =====================================================================
create table public.items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Zod-validated extracted facts (brand, model, category, specs, barcode/ISBN).
  -- Stored as JSONB; the authoritative shape is the app-side Zod attribute schema.
  attributes  jsonb not null default '{}'::jsonb,
  -- Assessed wear state; first-class because it drives pricing. Free-text here so
  -- the app's condition vocabulary can evolve without a migration.
  condition   text,
  -- Storage object paths (under the private `photos` bucket), scoped by user_id.
  photos      text[] not null default '{}'::text[],
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- =====================================================================
-- listings — generated, platform-specific sale copy for an item.
-- One item -> many listings (one per platform).
-- =====================================================================
create table public.listings (
  id          uuid primary key default gen_random_uuid(),
  -- Denormalized user_id so RLS can be enforced directly on this table without a
  -- join back to items (defense in depth; the FK to items also carries ownership).
  user_id     uuid not null references auth.users (id) on delete cascade,
  item_id     uuid not null references public.items (id) on delete cascade,
  -- 'ebay' | 'facebook' | 'mercari' (export packs vs real post). Free-text to allow
  -- adding platforms without a migration; the app validates the enum.
  platform    text not null,
  title       text,
  description text,
  -- Item specifics / tags / hashtags etc. — per-platform structured copy.
  copy        jsonb not null default '{}'::jsonb,
  -- 'draft' | 'queued' | 'published' | 'failed' (lifecycle; app-validated).
  status      text not null default 'draft',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- =====================================================================
-- messages — buyer Q&A. v1 runs on simulated messages; the seller is the tenant.
-- =====================================================================
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- A message is about an item and (optionally) a specific listing.
  item_id     uuid references public.items (id) on delete cascade,
  listing_id  uuid references public.listings (id) on delete cascade,
  -- 'inbound' (buyer question) | 'outbound' (seller reply).
  direction   text not null,
  body        text not null,
  -- The agent's grounded draft reply, pending seller approval.
  draft_reply text,
  -- 'new' | 'drafted' | 'approved' | 'sent' (app-validated lifecycle).
  status      text not null default 'new',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- =====================================================================
-- embeddings — pgvector store for the reference corpus + grounding.
-- Carries user_id for tenant isolation. The seeded reference corpus (PRD
-- "RAG") is owned by the seed/service role, not the anon/authenticated role.
-- =====================================================================
create table public.embeddings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Optional back-reference to the item this embedding describes (corpus rows may
  -- have none).
  item_id     uuid references public.items (id) on delete cascade,
  -- text-embedding-3-small dimensionality. Change here if the model changes.
  embedding   extensions.vector(1536),
  -- Free-text describing where the embedded content came from (e.g. seed corpus id).
  source_ref  text,
  metadata    jsonb not null default '{}'::jsonb,
  content     text,
  created_at  timestamptz not null default now()
);

-- Approximate-nearest-neighbour index for cosine similarity search (HNSW).
create index embeddings_embedding_hnsw_idx
  on public.embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

-- =====================================================================
-- prediction_logs — per-run record for the eval harness (PRD non-negotiable:
-- "Log every pipeline run's predictions from day one").
-- =====================================================================
create table public.prediction_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  item_id         uuid references public.items (id) on delete set null,
  -- The attributes the vision step extracted for this run.
  extracted_attrs jsonb not null default '{}'::jsonb,
  -- Price recommendation: { suggested, range, confidence, sources[] } shape.
  price           numeric,
  price_range     jsonb,          -- { low, high }
  confidence      numeric,        -- composite confidence score (0..1)
  -- Which PricingProvider tier fired: isbn | web_tight | web_wide | depreciation | llm_only.
  tier_fired      text,
  model           text,           -- model id used for the run
  created_at      timestamptz not null default now()
);

-- Helpful per-tenant lookup indexes (RLS still gates access; these are for perf).
create index items_user_id_idx           on public.items (user_id);
create index listings_user_id_idx        on public.listings (user_id);
create index listings_item_id_idx        on public.listings (item_id);
create index messages_user_id_idx        on public.messages (user_id);
create index messages_item_id_idx        on public.messages (item_id);
create index embeddings_user_id_idx      on public.embeddings (user_id);
create index prediction_logs_user_id_idx on public.prediction_logs (user_id);
create index prediction_logs_item_id_idx on public.prediction_logs (item_id);

-- keep updated_at honest on mutation
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger items_set_updated_at
  before update on public.items
  for each row execute function public.set_updated_at();

create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

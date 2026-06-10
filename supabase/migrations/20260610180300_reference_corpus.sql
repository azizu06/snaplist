-- SnapList — reference corpus (global RAG store). ADDITIVE migration.
--
-- WHY A NEW TABLE (the key design decision, documented):
-- The seeded **reference corpus** (PRD "RAG (pgvector)", CONTEXT.md "Reference corpus")
-- is GLOBAL reference data used to (a) corroborate pricing and (b) few-shot the listing
-- generator. It is NOT user-owned. The existing `public.embeddings` table is PER-USER
-- (user_id + RLS for tenant isolation) and is the right home for a user's own item
-- embeddings — but it is the WRONG home for shared reference data: shoehorning global
-- rows under a per-user table would force a fake/owner user_id and fight RLS.
--
-- So this is a dedicated table with NO user_id. RLS is still ENABLED (safe default),
-- with a SELECT policy granting READ to all authenticated users and NO insert/update/
-- delete policy — so the corpus is read-only to the app. Seeding happens via the
-- service role (which bypasses RLS), exactly like the seed script does. This keeps the
-- "RLS on everything" posture while modeling the data's real ownership (the platform).

-- =====================================================================
-- reference_corpus — global, read-only RAG reference data (no user_id).
-- =====================================================================
create table public.reference_corpus (
  id          uuid primary key default gen_random_uuid(),
  -- Stable seed identifier (e.g. "ref-electronics-sony-wh1000xm4"); also the dedupe key.
  source_ref  text not null unique,
  -- Hero-domain bucket: books | electronics | board-games | branded-gear | generic.
  category    text not null,
  brand       text,
  model       text,
  -- Realistic used/resale price (USD) — the pricing-corroboration signal feeding confidence.
  price       numeric not null check (price >= 0),
  -- Good, platform-competent listing copy — the few-shot exemplar for generation.
  content     text not null,
  -- Provenance + extra structured facts (specs, condition, platform).
  metadata    jsonb not null default '{}'::jsonb,
  -- Same dimensionality as public.embeddings (text-embedding-3-small = 1536).
  embedding   extensions.vector(1536),
  -- The embedder identity (e.g. "text-embedding-3-small" | "synthetic-fnv1a-bow") used
  -- to produce `embedding`. Persisted so a query embedded by a DIFFERENT model can be
  -- rejected rather than silently cosine-comparing across incompatible vector spaces.
  embedding_model text not null,
  created_at  timestamptz not null default now()
);

-- Approximate-nearest-neighbour index for cosine similarity (matches the embeddings table).
create index reference_corpus_embedding_hnsw_idx
  on public.reference_corpus
  using hnsw (embedding extensions.vector_cosine_ops);

-- Category filter is a common retrieval narrowing (e.g. only "electronics").
create index reference_corpus_category_idx on public.reference_corpus (category);

-- ---------------------------------------------------------------------
-- RLS: read-only to all authenticated users; no write policy (seed via service role).
-- ---------------------------------------------------------------------
alter table public.reference_corpus enable row level security;

-- Global reference data is readable by every signed-in user. There is intentionally
-- NO insert/update/delete policy: the anon/authenticated roles cannot mutate the corpus.
-- The seed script writes with the service role, which bypasses RLS.
create policy "reference_corpus_select_all_authenticated"
  on public.reference_corpus for select
  to authenticated
  using (true);

-- The local Supabase anon key authenticates as the `anon` role for unauthenticated
-- requests; reference data is non-sensitive global content, so grant it read access too
-- (read-only — still no write policy for either role).
create policy "reference_corpus_select_all_anon"
  on public.reference_corpus for select
  to anon
  using (true);

-- ---------------------------------------------------------------------
-- match_reference_corpus — the retrieval RPC the app calls (vector search).
-- SECURITY INVOKER so it runs under the caller's RLS (read-only select policy above).
-- Returns the top `match_count` rows by cosine similarity, optionally filtered by
-- category. similarity = 1 - cosine_distance ∈ [-1, 1] (1 = identical direction).
-- ---------------------------------------------------------------------
create or replace function public.match_reference_corpus(
  query_embedding extensions.vector(1536),
  match_count int default 5,
  filter_category text default null
)
returns table (
  id          uuid,
  source_ref  text,
  category    text,
  brand       text,
  model       text,
  price           numeric,
  content         text,
  metadata        jsonb,
  embedding_model text,
  similarity      double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    rc.id,
    rc.source_ref,
    rc.category,
    rc.brand,
    rc.model,
    rc.price,
    rc.content,
    rc.metadata,
    rc.embedding_model,
    1 - (rc.embedding <=> query_embedding) as similarity
  from public.reference_corpus rc
  where rc.embedding is not null
    and (filter_category is null or rc.category = filter_category)
  order by rc.embedding <=> query_embedding
  -- Clamp the caller-supplied count to a sane window (>=1, <=50) so a huge LIMIT
  -- can't become a performance / bulk-exfiltration footgun as the corpus grows.
  limit least(greatest(match_count, 1), 50);
$$;

-- =====================================================================
-- Issue #378 — honest export packs for unsupported marketplaces.
--
-- Facebook Marketplace, Mercari, and Depop are ASSISTED destinations:
-- SnapList prepares platform-appropriate text and photos, the seller
-- finishes the form. SnapList cannot observe the destination, so nothing
-- here may ever infer a listing went up.
--
-- Three changes:
--   1. `persist_export_packs` accepts Depop as the third destination.
--   2. An assisted-export pack row can never reach the eBay-only
--      `published` lifecycle — a database constraint, not a convention.
--   3. `export_handoffs` records Prepared → handed off → Shared, where
--      only an explicit, revision-guarded seller confirmation writes
--      Shared, and a replay returns the original receipt instead of
--      minting a second one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Depop joins the revision-guarded pack write.
-- ---------------------------------------------------------------------
create or replace function public.persist_export_packs(
  p_item_id uuid,
  p_source_review_revision uuid,
  p_expected_review_revision uuid,
  p_packs jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
begin
  if v_user_id is null or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_source_review_revision is null or p_expected_review_revision is null then
    raise exception using errcode = '22023', message = 'Export revisions are required.';
  end if;
  if jsonb_typeof(p_packs) is distinct from 'array'
    or jsonb_array_length(p_packs) < 1
    or jsonb_array_length(p_packs) > 3 then
    raise exception using errcode = '22023', message = 'Export packs are invalid.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_packs) as pack(
      platform text,
      title text,
      description text,
      copy jsonb
    )
    where pack.platform not in ('facebook', 'mercari', 'depop')
      or pack.title is null
      or btrim(pack.title) = ''
      or pack.description is null
      or btrim(pack.description) = ''
      or jsonb_typeof(pack.copy) is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Export packs are invalid.';
  end if;

  perform 1
  from public.items
  where id = p_item_id
    and user_id = v_user_id
    and review_content_revision is not distinct from p_source_review_revision
    and review_revision is not distinct from p_expected_review_revision
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review or seller price changed. Reload and try again.';
  end if;

  insert into public.listings (
    user_id, item_id, platform, title, description, copy, status, source_review_revision
  )
  select
    v_user_id,
    p_item_id,
    pack.platform,
    pack.title,
    pack.description,
    pack.copy,
    'draft',
    p_source_review_revision
  from jsonb_to_recordset(p_packs) as pack(
    platform text,
    title text,
    description text,
    copy jsonb
  )
  on conflict (item_id, platform, source_review_revision) do update
  set title = excluded.title,
      description = excluded.description,
      copy = excluded.copy,
      status = 'draft'
  where listings.user_id = v_user_id;
end;
$$;

comment on function public.persist_export_packs(uuid, uuid, uuid, jsonb) is
  'Persists the Facebook Marketplace, Mercari, and Depop export packs for one review content revision, refusing the write when review content or the seller price advanced (issues #15, #378).';

-- ---------------------------------------------------------------------
-- 2. `Prepared` and `Shared` are the only assisted-export outcomes.
--
-- `listings.status` is shared with the eBay adapter, where `published`
-- means a confirmed marketplace mutation. An assisted pack row reaching
-- that value would both misreport delivery to the seller and wrongly
-- block guided identity correction, which refuses to regenerate a
-- published listing.
-- ---------------------------------------------------------------------
do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.listings'::regclass
      and conname = 'listings_assisted_export_never_published'
  ) then
    alter table public.listings
      add constraint listings_assisted_export_never_published
      check (
        platform not in ('facebook', 'mercari', 'depop')
        or status is distinct from 'published'
      ) not valid;
    alter table public.listings
      validate constraint listings_assisted_export_never_published;
  end if;
end;
$constraint$;

-- ---------------------------------------------------------------------
-- 3. Durable handoff receipts.
-- ---------------------------------------------------------------------
create table public.export_handoffs (
  id uuid primary key default gen_random_uuid(),
  -- Denormalized Clerk id so RLS never needs a join back to items.
  user_id text not null,
  item_id uuid not null references public.items (id) on delete cascade,
  platform text not null,
  -- The review CONTENT revision the pack was built at. A newer revision
  -- is a different pack, and therefore a different receipt that starts
  -- at `Not shared`.
  source_review_revision uuid not null,
  created_at timestamptz not null default now(),
  -- When the seller actually handed the pack to the destination (share
  -- sheet, deep link, copy). Evidence that SnapList did its part; NOT
  -- evidence that anything was posted.
  handoff_at timestamptz,
  -- Written only by the seller's explicit confirmation.
  shared_at timestamptz,
  constraint export_handoffs_platform_check
    check (platform in ('facebook', 'mercari', 'depop')),
  -- The invariant, enforced by the database: a `Shared` receipt for a
  -- row that never performed a handoff is unrepresentable.
  constraint export_handoffs_shared_requires_handoff_check
    check (shared_at is null or handoff_at is not null),
  constraint export_handoffs_unique_per_revision
    unique (item_id, platform, source_review_revision),
  -- A receipt only exists for a pack SnapList actually prepared, and it
  -- dies with it. Paired with the sweep below, this is what keeps a
  -- `Shared` claim from outliving the listing it described (retention
  -- matrix: export-packs / review-revision-invalidates-pack).
  constraint export_handoffs_pack_fkey
    foreign key (item_id, platform, source_review_revision)
    references public.listings (item_id, platform, source_review_revision)
    on delete cascade
);

comment on table public.export_handoffs is
  'Durable Prepared/Shared receipts for assisted export destinations. `Shared` is the seller''s own claim that they posted the listing; SnapList cannot observe the destination and never infers it (issue #378).';
comment on column public.export_handoffs.handoff_at is
  'When the seller handed the pack to the destination. Proves SnapList delivered text and photos, never that a listing exists.';
comment on column public.export_handoffs.shared_at is
  'Set only by an explicit, revision-guarded seller confirmation, and cleared by their undo.';

create index export_handoffs_item_revision_idx
  on public.export_handoffs (item_id, source_review_revision);

-- ---------------------------------------------------------------------
-- Keep the assisted destinations coherent when a pack is invalidated.
--
-- Four production paths drop an item's cached packs when its identity or
-- estimate changes — `regenerate_review_listing`, `save_review_edits`,
-- `sharpen_review_estimate`, and the guided-correction evidence
-- completion — and each carries the literal
-- `platform in ('facebook', 'mercari')` inside a large SECURITY DEFINER
-- body. Adding a third destination to those literals would mean
-- re-declaring roughly 600 lines of tenancy-critical guided-correction
-- code verbatim, on a surface this issue does not own, to change one
-- list. A sweep expresses the actual rule once instead: assisted export
-- packs for an item are invalidated together, whatever the caller
-- remembered to name. Without it a Depop pack — and a `Shared` receipt
-- for it — would outlive the identity it described.
--
-- A statement trigger fires even when its statement touched no rows, so
-- the sweep's own delete would re-enter forever without an explicit
-- guard. `pg_trigger_depth()` is 1 at the top level and 2 when the sweep
-- re-enters itself, which also correctly skips a cascade-driven delete:
-- a cascade already removes every row the sweep would.
--
-- CONSTRAINT ON FUTURE CALLERS: the guard suppresses the sweep for a
-- delete issued from inside ANY trigger, not only from this one. That is
-- safe for every path today — the four invalidation RPCs are plain
-- function bodies at depth 0, and the only cascade into `listings` comes
-- from `items`, which removes every row anyway. But a future
-- pack-invalidation delete placed inside a trigger body would silently
-- not sweep, which is this very defect one level deeper. Keep
-- pack invalidation in plain function bodies.
-- ---------------------------------------------------------------------
create or replace function private.sweep_assisted_export_packs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;

  delete from public.listings as pack
  using deleted_packs as gone
  where pack.item_id = gone.item_id
    and pack.user_id = gone.user_id
    and pack.platform in ('facebook', 'mercari', 'depop')
    and gone.platform in ('facebook', 'mercari', 'depop');
  return null;
end;
$$;

comment on function private.sweep_assisted_export_packs() is
  'Invalidates an item''s remaining assisted export packs whenever any one of them is deleted, so a destination missing from an older call site cannot outlive the identity it described (issue #378).';

revoke all on function private.sweep_assisted_export_packs()
  from public, anon, authenticated, service_role;

create trigger sweep_assisted_export_packs
after delete on public.listings
referencing old table as deleted_packs
for each statement
execute function private.sweep_assisted_export_packs();

alter table public.export_handoffs enable row level security;

create policy export_handoffs_select_own on public.export_handoffs
  for select
  using (user_id = public.clerk_user_id());

revoke all on table public.export_handoffs from public, anon, authenticated, service_role;
-- Read is the seller's; every write goes through the guarded capability
-- below, so a direct client write cannot skip the revision or handoff
-- checks.
grant select on table public.export_handoffs to authenticated;

-- Shared guard: the item must be owned by the caller and still sit at
-- BOTH the content revision the pack was built at and the full revision
-- the client rendered. `for share` blocks a concurrent price edit for
-- the length of the confirmation without taking a writer's lock.
create or replace function private.assert_export_pack_current(
  p_user_id text,
  p_item_id uuid,
  p_platform text,
  p_source_review_revision uuid,
  p_expected_review_revision uuid
)
returns void
language plpgsql
-- Explicitly invoker: this helper carries no privilege of its own. It runs
-- inside the SECURITY DEFINER capabilities below and must never become a
-- second way to reach `public.items` on its own.
security invoker
set search_path = ''
as $$
begin
  if coalesce(p_user_id, '') = ''
    or p_item_id is null
    or p_source_review_revision is null
    or p_expected_review_revision is null then
    raise exception using errcode = '42501', message = 'Export handoff authorization is required.';
  end if;
  if p_platform is null or p_platform not in ('facebook', 'mercari', 'depop') then
    raise exception using
      errcode = '22023',
      message = 'Only assisted export destinations receive a handoff receipt.';
  end if;

  perform 1
  from public.items
  where id = p_item_id
    and user_id = p_user_id
    and review_content_revision is not distinct from p_source_review_revision
    and review_revision is not distinct from p_expected_review_revision
  for share;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'This listing changed. Reopen the export pack and try again.';
  end if;
end;
$$;

comment on function private.assert_export_pack_current(text, uuid, text, uuid, uuid) is
  'Fails closed unless the caller owns the item and the pack is still current, so a confirmation left mounted over a stale pack can never write Shared (issue #378).';

-- Records that the seller handed the pack to the destination. Idempotent:
-- a redelivered or retried handoff keeps the first timestamp.
create or replace function public.record_export_handoff(
  p_item_id uuid,
  p_platform text,
  p_source_review_revision uuid,
  p_expected_review_revision uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_handoff_at timestamptz;
begin
  perform private.assert_export_pack_current(
    v_user_id, p_item_id, p_platform, p_source_review_revision, p_expected_review_revision
  );

  -- SnapList cannot hand off text it never prepared.
  perform 1
  from public.listings
  where item_id = p_item_id
    and user_id = v_user_id
    and platform = p_platform
    and source_review_revision = p_source_review_revision;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'This listing changed. Reopen the export pack and try again.';
  end if;

  insert into public.export_handoffs as handoff (
    user_id, item_id, platform, source_review_revision, handoff_at
  )
  values (v_user_id, p_item_id, p_platform, p_source_review_revision, now())
  on conflict (item_id, platform, source_review_revision) do update
  set handoff_at = coalesce(handoff.handoff_at, excluded.handoff_at)
  where handoff.user_id = v_user_id
  returning handoff.handoff_at into v_handoff_at;

  if v_handoff_at is null then
    raise exception using
      errcode = 'P0002',
      message = 'This listing changed. Reopen the export pack and try again.';
  end if;
  return v_handoff_at;
end;
$$;

comment on function public.record_export_handoff(uuid, text, uuid, uuid) is
  'Records that the seller handed a current export pack to an assisted destination. Never means the listing was posted (issue #378).';

-- The only path that writes `Shared`. Replay-safe: a retried confirmation
-- returns the original receipt rather than minting a second delivery.
create or replace function public.mark_export_shared(
  p_item_id uuid,
  p_platform text,
  p_source_review_revision uuid,
  p_expected_review_revision uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_shared_at timestamptz;
begin
  perform private.assert_export_pack_current(
    v_user_id, p_item_id, p_platform, p_source_review_revision, p_expected_review_revision
  );

  update public.export_handoffs as handoff
  set shared_at = coalesce(handoff.shared_at, now())
  where handoff.user_id = v_user_id
    and handoff.item_id = p_item_id
    and handoff.platform = p_platform
    and handoff.source_review_revision = p_source_review_revision
    and handoff.handoff_at is not null
  returning handoff.shared_at into v_shared_at;

  if v_shared_at is null then
    raise exception using
      errcode = 'P0002',
      message = 'Only you can confirm this. Share the pack first, then mark it shared.';
  end if;
  return v_shared_at;
end;
$$;

comment on function public.mark_export_shared(uuid, text, uuid, uuid) is
  'The seller''s explicit claim that they posted the listing at the destination. The only writer of Shared, and it aborts on a stale pack or a row that never performed a handoff (issue #378).';

-- The seller can take back a confirmation. The handoff itself stands:
-- SnapList did deliver the text, it just no longer claims a listing.
create or replace function public.undo_export_shared(
  p_item_id uuid,
  p_platform text,
  p_source_review_revision uuid,
  p_expected_review_revision uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_found boolean;
begin
  perform private.assert_export_pack_current(
    v_user_id, p_item_id, p_platform, p_source_review_revision, p_expected_review_revision
  );

  update public.export_handoffs as handoff
  set shared_at = null
  where handoff.user_id = v_user_id
    and handoff.item_id = p_item_id
    and handoff.platform = p_platform
    and handoff.source_review_revision = p_source_review_revision
    and handoff.shared_at is not null
  returning true into v_found;

  if not coalesce(v_found, false) then
    raise exception using
      errcode = 'P0002',
      message = 'That destination is not marked as shared.';
  end if;
end;
$$;

comment on function public.undo_export_shared(uuid, text, uuid, uuid) is
  'Clears a seller''s share confirmation, returning the destination to prepared without erasing that a handoff happened (issue #378).';

revoke all on function private.assert_export_pack_current(text, uuid, text, uuid, uuid) from public;
revoke all on function public.record_export_handoff(uuid, text, uuid, uuid) from public;
revoke all on function public.mark_export_shared(uuid, text, uuid, uuid) from public;
revoke all on function public.undo_export_shared(uuid, text, uuid, uuid) from public;
grant execute on function public.record_export_handoff(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.mark_export_shared(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.undo_export_shared(uuid, text, uuid, uuid) to authenticated;

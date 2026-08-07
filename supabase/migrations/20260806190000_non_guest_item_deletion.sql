-- #181 — Complete non-guest SnapList deletion for one item.
--
-- `docs/contracts/lean-mvp-retention-v1.json` names two executors. Account
-- erasure (`snaplist-tenant-data-deletion-capability` at account scope) landed
-- with #384; the item-scoped half never existed. Migration 20260801030000 says
-- so in its own words: "Item deletion and guest recovery expiry have no leaf
-- deletion capability anywhere in the repository to hook into". This is that
-- leaf.
--
-- Two things the FK graph alone cannot do, and why an explicit executor is
-- required rather than a `on delete cascade` edge:
--
--   1. `public.prediction_logs.item_id` is ON DELETE SET NULL, so a bare item
--      delete keeps the pricing evidence and merely forgets which item it
--      described. The matrix binds `pricing-evidence` to `item-deletion`.
--   2. Storage objects have no foreign key at all. Removal is published as
--      durable leased work so the deleting transaction stays short and the
--      object is proved absent by the cleanup capability, which is the
--      completion proof the matrix names for `private-storage-photos`.
--
-- The seller's AI-item credits are deliberately NOT touched here: the matrix
-- retains `ai-item-credits` for the account lifetime, and a settled credit
-- represents value already delivered.

-- Narrow the direct delete path down to an item that has produced nothing.
--
-- `items_delete_own` let an authenticated seller delete ANY of their items
-- straight from the client. That cascade takes the listing and run but nulls the
-- prediction log's `item_id`, leaves the voice handoff untouched, and publishes
-- nothing for the Storage objects — so the leak was reachable by anyone holding a
-- session, and adding an executor beside it would not have closed anything.
--
-- It cannot simply be dropped, though: `runPipelineAndPersist`
-- (src/lib/pipeline/persist.ts) deletes its own anchor item through the caller's
-- RLS-scoped client when a run fails, so the half-built row does not strand
-- forever as "Processing". Dropping the policy does not make that delete fail —
-- RLS filters rather than raises, so it silently matches zero rows and reports
-- success. The orphan survives and nothing is logged.
--
-- So the policy is rebuilt around the one case that needs it: an item with no
-- listing and no durable run has produced no draft, no export pack, no publish
-- record, and no credit reservation (a reservation is bound to a run), so there
-- is nothing for a deletion receipt to report and nothing for the cleanup
-- executor to purge. Every item a seller can act on fails that predicate and must
-- go through `public.delete_item`.
--
-- The predicate is evaluated in a SECURITY DEFINER helper rather than inline: a
-- policy whose guard depends on the caller's own RLS visibility would silently
-- become vacuous — and the delete permitted — if a future change narrowed the
-- SELECT policy on either child table.
drop policy items_delete_own on public.items;

create function private.item_has_no_derived_state(
  p_item_id uuid,
  p_user_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
      select 1
      from public.listings listing
      where listing.item_id = p_item_id
        and listing.user_id = p_user_id
    )
    and not exists (
      select 1
      from public.pipeline_runs run
      where run.item_id = p_item_id
        and run.user_id = p_user_id
    )
$$;

revoke all on function private.item_has_no_derived_state(uuid, text)
  from public, anon, service_role;
grant execute on function private.item_has_no_derived_state(uuid, text)
  to authenticated;

create policy items_delete_own_anchor
  on public.items for delete
  to authenticated
  using (
    public.clerk_user_id() = user_id
    and private.item_has_no_derived_state(id, user_id)
  );

-- A SETTLED credit must outlive the run it paid for.
--
-- `ai_item_credit_reservations` binds to `pipeline_runs` ON DELETE CASCADE, and
-- `pipeline_runs` binds to `items` ON DELETE CASCADE, so deleting an item took
-- the settled reservation with it. Allowance consumption is counted as
-- `count(*)` over reservations in state ('reserved', 'settled') for the period
-- (20260716180000_ai_item_credit_ledger.sql), which made deleting an item a
-- refund: a seller could reclaim a spent AI-item credit — including the free
-- included first run — and buy unbounded provider work for nothing.
--
-- The rule is not "always cascade" and not "always detach" — it is the one
-- AGENTS.md already states: settle exactly once when value is durably delivered,
-- restore exactly once on failure/cancel before that point. A reservation that
-- never settled delivered nothing, so a vanishing run must take it with it or the
-- allowance stays consumed forever (including a guest's one free run). A SETTLED
-- reservation paid for a draft the seller received, so it must survive.
--
-- The FK action cannot branch on state, and making it SET NULL for everyone would
-- change accounting on every path that destroys a run — guest cleanup, expiry,
-- account erasure — which is out of this issue's contract (AC5). So the cascade
-- stays as the general rule and `public.delete_item` detaches the settled row
-- explicitly before deleting the item. The seller-facing door is the only place
-- the exception is needed: it is now the only way a seller can reach a delete of
-- an item that has a run at all (see the narrowed policy above).
--
-- Detaching still requires both bindings to be nullable. `user_id` stays NOT NULL
-- so the reservation never loses its tenant, which keeps RLS, the account-erasure
-- census, and the allowance-period FK intact.
alter table public.ai_item_credit_reservations
  alter column pipeline_run_id drop not null,
  alter column item_id drop not null;

-- `logical_run_key` is the submission's idempotency key, and it is unique per
-- seller so two live runs cannot claim the same credit. Detaching keeps the row
-- and therefore keeps the key, which the cascade used to free — so the detach
-- would otherwise leave a spent key permanently reserved by a run that no longer
-- exists.
--
-- That is reachable by a seller doing nothing wrong: delete an item, then let an
-- offline outbox replay the same submission whose 200 was never seen.
-- `stage_pipeline_batch` finds no run, stages a fresh item and run, and the
-- reserve trigger inserts under the same key — 23505 out of the RPC, at a seller
-- who still has allowance. Scoping the index to attached rows says what the
-- constraint actually means: one live run per key. Detached rows still spend
-- their credit, because consumption counts state, not this key.
alter table public.ai_item_credit_reservations
  drop constraint ai_item_credit_reservations_logical_run_key;

create unique index ai_item_credit_reservations_logical_run_key
  on public.ai_item_credit_reservations (user_id, logical_run_key)
  where pipeline_run_id is not null;

-- `private.enforce_ai_item_credit_transition` treats the reservation's identity
-- columns as immutable, which is what stops a caller from moving a spent credit
-- onto a different run or period. The FK action above is a legitimate fourth
-- shape, so it gets its own narrow predicate rather than a hole in the guard:
-- both bindings must go to NULL together, and every other identity column, plus
-- the state, must be untouched.
create function private.ai_item_credit_run_detach_allowed(
  p_old public.ai_item_credit_reservations,
  p_new public.ai_item_credit_reservations
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_old.pipeline_run_id is not null
     and p_new.pipeline_run_id is null
     and p_old.item_id is not null
     and p_new.item_id is null
     and p_new.user_id is not distinct from p_old.user_id
     and p_new.allowance_period_id is not distinct from p_old.allowance_period_id
     and p_new.logical_run_key is not distinct from p_old.logical_run_key
     and p_new.photo_set_fingerprint is not distinct from p_old.photo_set_fingerprint
     and p_new.reserved_at is not distinct from p_old.reserved_at
     and p_new.state is not distinct from p_old.state
$$;

revoke all on function private.ai_item_credit_run_detach_allowed(
  public.ai_item_credit_reservations, public.ai_item_credit_reservations
) from public, anon, authenticated, service_role;

-- Body reproduced from 20260720003000 with one change: the identity block now
-- routes a detach past the guest-claim capacity check, because a detach rebinds
-- nothing and the period it stays on is by definition already at capacity.
create or replace function private.enforce_ai_item_credit_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_allowance integer;
  v_target_used integer;
begin
  if (
    new.user_id,
    new.pipeline_run_id,
    new.item_id,
    new.allowance_period_id,
    new.logical_run_key,
    new.photo_set_fingerprint,
    new.reserved_at
  ) is distinct from (
    old.user_id,
    old.pipeline_run_id,
    old.item_id,
    old.allowance_period_id,
    old.logical_run_key,
    old.photo_set_fingerprint,
    old.reserved_at
  ) then
    if private.ai_item_credit_run_detach_allowed(old, new) then
      null;
    elsif private.guest_claim_credit_remap_allowed(old, new) then
      select period.allowance into v_target_allowance
      from public.ai_item_allowance_periods period
      where period.id = new.allowance_period_id
        and period.user_id = new.user_id
      for update;
      if not found then
        raise exception using
          errcode = '23503',
          message = 'Guest claim target allowance period is unavailable';
      end if;

      select count(*) into v_target_used
      from public.ai_item_credit_reservations reservation
      where reservation.allowance_period_id = new.allowance_period_id
        and reservation.id <> old.id
        and (
          reservation.state in ('reserved', 'settled')
          or (
            reservation.state = 'restored'
            and reservation.retry_reservation_count
              > reservation.retry_restore_count
          )
        );
      if v_target_used >= v_target_allowance then
        raise exception using
          errcode = '23505',
          message = 'Account included credit is already bound to another run';
      end if;
    else
      raise exception using
        errcode = '23514',
        message = 'AI-item credit reservation identity is immutable';
    end if;
  end if;

  if new.state is distinct from old.state
    and not (
      (old.state = 'reserved' and new.state in ('settled', 'restored'))
      or (old.state = 'restored' and new.state = 'settled')
    ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Illegal AI-item credit transition: %s -> %s', old.state, new.state
      );
  end if;

  if old.state = 'restored'
    and new.state = 'settled'
    and old.retry_reservation_count <> old.retry_restore_count + 1 then
    raise exception using
      errcode = '23514',
      message = 'A restored AI-item credit must be reclaimed before settlement';
  end if;

  if new.state is not distinct from old.state and (
    new.settled_at,
    new.restored_at,
    new.settled_review_revision,
    new.listing_id,
    new.prediction_log_id
  ) is distinct from (
    old.settled_at,
    old.restored_at,
    old.settled_review_revision,
    old.listing_id,
    old.prediction_log_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit terminal evidence is immutable';
  end if;

  if (
    new.retry_reservation_count,
    new.retry_restore_count
  ) is distinct from (
    old.retry_reservation_count,
    old.retry_restore_count
  ) and not (
    old.state = 'restored'
    and new.state = 'restored'
    and (
      (
        old.retry_reservation_count = old.retry_restore_count
        and new.retry_reservation_count = old.retry_reservation_count + 1
        and new.retry_restore_count = old.retry_restore_count
      )
      or (
        old.retry_reservation_count = old.retry_restore_count + 1
        and new.retry_reservation_count = old.retry_reservation_count
        and new.retry_restore_count = old.retry_restore_count + 1
      )
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Illegal AI-item manual retry accounting transition';
  end if;

  if old.guided_correction_completed_at is not null
    and new.guided_correction_revision is distinct from old.guided_correction_revision then
    raise exception using
      errcode = '23514',
      message = 'Completed guided correction identity is immutable';
  end if;
  if old.guided_correction_completed_at is not null
    and new.guided_correction_started_at is distinct from old.guided_correction_started_at then
    raise exception using
      errcode = '23514',
      message = 'Completed guided correction start is immutable';
  end if;
  if old.guided_correction_completed_at is not null
    and new.guided_correction_completed_at
        is distinct from old.guided_correction_completed_at then
    raise exception using
      errcode = '23514',
      message = 'Guided correction completion is immutable';
  end if;
  if new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit time cannot move backward';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_ai_item_credit_transition()
  from public, anon, authenticated, service_role;

alter table private.pipeline_storage_cleanup_jobs
  drop constraint pipeline_storage_cleanup_source_check;

alter table private.pipeline_storage_cleanup_jobs
  add constraint pipeline_storage_cleanup_source_check
  check (
    source_type = any (array[
      'staging',
      'abandoned_item',
      'guest_recovery',
      'guest_claim_copy',
      'raw_voice',
      'item_deletion'
    ])
  );

-- A third handoff state, for a voice note whose item is gone but whose raw audio
-- has not yet been proved absent.
--
-- The handoff carries no foreign key to `items`, so deletion has to reach it
-- explicitly — but it cannot simply be deleted: `raw_audio_deleted_at` on this
-- row is the completion proof the retention matrix names for
-- `private-storage-raw-voice`, and removing the row would destroy the proof
-- while leaving the object in Storage. `released` drops the item and run
-- identity immediately, strips the receipt down to the storage path the pending
-- cleanup still reads, and keeps the row alive purely as the proof carrier.
--
-- Nothing prunes a released row on its own: the 24-hour `cleanup_after` ceiling
-- publishes deletion for the object, not for this row, and the only statements
-- that delete from this table are account erasure's. So the row is retained
-- until the account is erased, which is why what it retains has to be nothing
-- the item-deletion trigger claims.
alter table private.mobile_item_submission_voice_handoffs
  drop constraint mobile_item_submission_voice_handoffs_state_check;

alter table private.mobile_item_submission_voice_handoffs
  add constraint mobile_item_submission_voice_handoffs_state_check check (
    state = any (array['staged', 'accepted', 'released'])
  );

alter table private.mobile_item_submission_voice_handoffs
  drop constraint mobile_item_submission_voice_handoffs_check;

alter table private.mobile_item_submission_voice_handoffs
  add constraint mobile_item_submission_voice_handoffs_check check (
    (
      state = 'staged'
      and item_id is null and run_id is null and accepted_at is null
    )
    or (
      state = 'accepted'
      and item_id is not null and run_id is not null and accepted_at is not null
    )
    or (
      state = 'released'
      and item_id is null and run_id is null and accepted_at is not null
    )
  );

comment on constraint mobile_item_submission_voice_handoffs_check
  on private.mobile_item_submission_voice_handoffs is
  'staged: not yet accepted. accepted: bound to one item and run. released: the item was deleted and only the raw-audio absence proof remains.';

-- `released` has to be terminal, or the new state is a hole rather than a state.
--
-- Body reproduced from 20260730120000 with one added branch. The accept path
-- returned early only for `state = 'accepted'` and otherwise fell through to an
-- unconditional bind, which the widened CHECK now permits from `released` too.
-- That is reachable, not theoretical: `private.mobile_item_submissions` cascades
-- away with the item, so a client replaying the same idempotency key after a
-- deletion — an offline outbox entry whose 200 was never seen — is no longer
-- recognised as a replay, while the handoff survives on its own primary key
-- `(user_id, idempotency_key)`. The bind would then attach raw audio already
-- queued for deletion, or already proved absent, to a brand new item and run.
--
-- The refusal is placed before the receipt comparison deliberately. Release
-- strips the receipt, so a replay carrying the original would otherwise be
-- turned away as an idempotency conflict — the right outcome for the wrong
-- reason, and one that stops reporting the real cause the moment the payload
-- changes again.
create or replace function private.accept_mobile_submission_voice_handoff(
  p_user_id text,
  p_idempotency_key uuid,
  p_voice_receipt jsonb,
  p_item_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff private.mobile_item_submission_voice_handoffs%rowtype;
begin
  select handoff.* into v_handoff
  from private.mobile_item_submission_voice_handoffs handoff
  where handoff.user_id = p_user_id
    and handoff.idempotency_key = p_idempotency_key
  for update;

  if p_voice_receipt is null then
    if found then
      raise exception using
        errcode = '23514',
        message = 'Mobile item submission idempotency conflict';
    end if;
    return null;
  end if;

  if found and v_handoff.state = 'released' then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission voice handoff was released';
  end if;

  if not found or v_handoff.receipt is distinct from p_voice_receipt then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;

  if v_handoff.state = 'accepted' then
    if v_handoff.item_id is distinct from p_item_id
      or v_handoff.run_id is distinct from p_run_id then
      raise exception using
        errcode = '23514',
        message = 'Mobile item submission voice handoff conflicts';
    end if;
    return v_handoff.receipt;
  end if;

  update private.mobile_item_submission_voice_handoffs handoff
  set state = 'accepted',
      item_id = p_item_id,
      run_id = p_run_id,
      accepted_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where handoff.user_id = p_user_id
    and handoff.idempotency_key = p_idempotency_key;
  return p_voice_receipt;
end;
$$;

revoke all on function private.accept_mobile_submission_voice_handoff(
  text, uuid, jsonb, uuid, uuid
) from public, anon, authenticated, service_role;

-- Tenancy is derived from `public.clerk_user_id()` and then re-asserted on every
-- statement, so the definer rights buy access to `private` bookkeeping without
-- ever widening which rows the caller can reach. The erasure fence still runs on
-- each affected table and refuses the whole transaction once an erasure
-- generation exists for this seller.
create function public.delete_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_item public.items%rowtype;
  v_photo_paths text[];
  v_handoff record;
  v_blocked text[] := array[]::text[];
  v_retained text[] := array[]::text[];
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using
      errcode = '42501',
      message = 'Item deletion requires an authenticated seller';
  end if;
  if p_item_id is null then
    raise exception using
      errcode = '22023',
      message = 'Item deletion requires an item';
  end if;

  select item.* into v_item
  from public.items item
  where item.id = p_item_id
    and item.user_id = v_user_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Item was not found';
  end if;

  -- Lock the run and listing rows before reading their state, so a worker
  -- claiming the run or a publish taking its claim cannot slip between the
  -- check and the delete. Without this the blockers below would be advisory.
  perform 1
  from public.pipeline_runs run
  where run.item_id = p_item_id
    and run.user_id = v_user_id
  for update;

  perform 1
  from public.listings listing
  where listing.item_id = p_item_id
    and listing.user_id = v_user_id
  for update;

  if exists (
    select 1
    from public.pipeline_runs run
    where run.item_id = p_item_id
      and run.user_id = v_user_id
      and run.status in ('queued', 'running', 'retrying')
  ) then
    v_blocked := array_append(v_blocked, 'run-in-progress');
  end if;

  if exists (
    select 1
    from public.listings listing
    where listing.item_id = p_item_id
      and listing.user_id = v_user_id
      and listing.ebay_status = 'publishing'
  ) then
    v_blocked := array_append(v_blocked, 'ebay-publish-in-progress');
  end if;

  -- A refusal, not an error: the seller gets a reason they can act on, and
  -- nothing in the item graph has moved.
  if cardinality(v_blocked) > 0 then
    return jsonb_build_object(
      'status', 'blocked',
      'item_id', p_item_id,
      'blocked_by', to_jsonb(v_blocked),
      'retained_records', '[]'::jsonb
    );
  end if;

  -- Provider-owned deletion is not SnapList deletion. A listing that reached
  -- eBay stays on eBay; naming it is what keeps this from being a false
  -- completion claim.
  if exists (
    select 1
    from public.listings listing
    where listing.item_id = p_item_id
      and listing.user_id = v_user_id
      and coalesce(btrim(listing.ebay_listing_id), '') <> ''
  ) then
    v_retained := array_append(v_retained, 'ebay-live-listing');
  end if;

  select coalesce(array_agg(distinct photo_path), array[]::text[])
    into v_photo_paths
  from unnest(coalesce(v_item.photos, array[]::text[])) photo_path
  where nullif(btrim(photo_path), '') is not null;

  if cardinality(v_photo_paths) > 0 then
    insert into private.pipeline_storage_cleanup_jobs (
      source_type, source_id, photo_paths
    )
    values ('item_deletion', p_item_id, v_photo_paths)
    on conflict (source_type, source_id) do nothing;
  end if;

  -- Explicit, because the FK only nulls the binding.
  delete from public.prediction_logs
  where item_id = p_item_id
    and user_id = v_user_id;

  for v_handoff in
    select handoff.user_id,
           handoff.idempotency_key,
           handoff.cleanup_id,
           handoff.receipt->>'storage_path' storage_path
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.user_id = v_user_id
      and handoff.item_id = p_item_id
    order by handoff.cleanup_id
    for update
  loop
    if nullif(btrim(coalesce(v_handoff.storage_path, '')), '') is not null then
      perform private.queue_raw_seller_voice_cleanup(
        v_handoff.user_id,
        v_handoff.idempotency_key,
        v_handoff.cleanup_id,
        v_handoff.storage_path
      );
    end if;
    -- The row outlives the item, so its payload must not. The retention matrix
    -- row `seller-voice-transcript` names the transcript, the seller_voice
    -- provenance, and the language tag as absent by the earliest applicable
    -- deletion trigger, and `receipt->>'locale'` is that language tag. Keeping
    -- the whole receipt alive on a row with no terminal disposition would retain
    -- it indefinitely.
    --
    -- The storage path stays because the cleanup still in flight genuinely needs
    -- it: `prepare_raw_seller_voice_retention` and the account-erasure sweep both
    -- re-read `receipt->>'storage_path'` to republish removal for a job that
    -- dead-lettered, and `mobile_item_submission_voice_handoffs_storage_path_key`
    -- indexes that expression. Nothing else here is proof of anything.
    --
    -- `transcription_outcome` is deliberately untouched: account erasure reads it
    -- to report `hosted-transcription-provider-copy` as a record SnapList cannot
    -- delete, and clearing it here would turn an honest retained-record
    -- disclosure into silence.
    update private.mobile_item_submission_voice_handoffs handoff
    set state = 'released',
        item_id = null,
        run_id = null,
        receipt = jsonb_build_object(
          'storage_path', handoff.receipt->>'storage_path'
        ),
        updated_at = statement_timestamp()
    where handoff.user_id = v_handoff.user_id
      and handoff.idempotency_key = v_handoff.idempotency_key;
  end loop;

  -- Carries no foreign key to `items`, and its own FK to the credit ledger
  -- references (id, user_id, item_id) — so it has to go before the ledger row
  -- is detached, or the detach would violate it.
  delete from private.guided_correction_completion_capabilities
  where item_id = p_item_id
    and user_id = v_user_id;

  -- Release the spent credit from the vanishing run so the cascade below cannot
  -- reach it. Allowance consumption is `count(*)` over ('reserved', 'settled')
  -- rows, so letting a SETTLED reservation cascade away would refund a credit the
  -- seller already spent — including the free included first run — and turn
  -- delete-and-rescan into unlimited provider work.
  --
  -- Only 'settled' is detached. A reservation still 'reserved' or 'restored' at
  -- this point bought nothing the seller kept, so it cascades exactly as it did
  -- before #181 and the allowance goes back.
  update public.ai_item_credit_reservations
  set pipeline_run_id = null,
      item_id = null
  where user_id = v_user_id
    and item_id = p_item_id
    and state = 'settled';

  delete from public.items
  where id = p_item_id
    and user_id = v_user_id;

  return jsonb_build_object(
    'status', 'deleted',
    'item_id', p_item_id,
    'blocked_by', '[]'::jsonb,
    'retained_records', to_jsonb(v_retained)
  );
end;
$$;

revoke all on function public.delete_item(uuid) from public, anon, service_role;
grant execute on function public.delete_item(uuid) to authenticated;

comment on function public.delete_item(uuid) is
  'Deletes one seller-owned item and the SnapList-owned rows the lean-MVP '
  'retention matrix binds to the item-deletion trigger, publishing Storage '
  'removal as durable leased cleanup work. Two things survive by design and '
  'neither is a deletion claim: the raw seller voice handoff stays as the '
  'carrier for the absence proof its own retention row names, stripped to the '
  'storage path that pending cleanup reads, and provider-owned records are '
  'reported in retained_records rather than removed.';

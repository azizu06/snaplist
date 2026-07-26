-- Issue #504: deny a spent-allowance claim before the seller copies any photos.
--
-- `begin_guest_draft_claim` never looked at the target account's included-first-run
-- allowance. A seller signing into an account that had already used its included
-- item was handed `copy_required` with the full object manifest, copied every
-- photo into the account namespace, called `complete`, and only then learned the
-- claim could never succeed. The outcome was decided before the first byte moved.
--
-- The check cannot move. `begin` and `complete` are separated by an unbounded
-- client upload (lease default 300s, bounded at 3600s), and inside that window the
-- target account can spend its included run on another device. `complete` remaps
-- the credit under `ai-item-credit:<user>` with a row lock on the allowance period
-- and stays the authority. So the check is duplicated as an unlocked advisory read
-- at `begin`, not relocated.
--
-- Both sites also now distinguish the two truths the old single 23505 conflated:
--
--   SL001  permanent. The account's included run is `settled` and never returns.
--   SL002  transient. A `reserved` run is in flight and may still be `restored`,
--          which frees the period.
--
-- Expand-contract: this file redefines the two functions in place of editing the
-- shipped 20260717120000 migration. The recovery state machine, the credit remap,
-- the lock set at `complete`, and the cross-account P0002 fence are unchanged.

create or replace function private.enforce_guest_claim_account_allowance(
  p_period_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block text;
begin
  -- One occupancy predicate and one error vocabulary for both call sites, so the
  -- advisory preflight and the authoritative check cannot drift into disagreeing
  -- about what occupies an included period. Only `reserved` and `settled` occupy
  -- it; `restored` released it. `settled` wins when both are present, because a
  -- spent run is the permanent truth and outranks one still in flight.
  select case
      when bool_or(reservation.state = 'settled') then 'settled'
      when bool_or(reservation.state = 'reserved') then 'reserved'
    end
  into v_block
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = p_period_id
    and reservation.state in ('reserved', 'settled');

  if v_block = 'settled' then
    raise exception using
      errcode = 'SL001',
      message = 'Account included credit is already spent on another run';
  elsif v_block = 'reserved' then
    raise exception using
      errcode = 'SL002',
      message = 'Account included credit is reserved by a run in flight';
  end if;
end;
$$;

revoke all on function private.enforce_guest_claim_account_allowance(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.begin_guest_draft_claim(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_idempotency_key uuid,
  p_claim_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
  v_objects jsonb;
  v_retry_after integer;
  v_bound_recovery_id uuid;
  v_target_period_id uuid;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_target_user_id = p_guest_user_id
    or p_idempotency_key is null
    or p_claim_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'guest-claim-idempotency:' || p_target_user_id || ':'
        || p_idempotency_key::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.guest_user_id = p_guest_user_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.claim_idempotency_user_id is not null then
    if v_recovery.claim_idempotency_user_id is distinct from p_target_user_id then
      raise exception using errcode = 'P0002', message = 'Guest recovery not found';
    end if;
    if v_recovery.claim_idempotency_key is distinct from p_idempotency_key then
      raise exception using
        errcode = '23505',
        message = 'Guest claim Idempotency-Key is already bound';
    end if;
  end if;

  select recovery.id into v_bound_recovery_id
  from private.guest_draft_recoveries recovery
  where recovery.claim_idempotency_user_id = p_target_user_id
    and recovery.claim_idempotency_key = p_idempotency_key;
  if found and v_bound_recovery_id <> v_recovery.id then
    raise exception using
      errcode = '23505',
      message = 'Guest claim Idempotency-Key is already bound';
  end if;

  -- Issue #504: an advisory, unlocked read of the target account's included
  -- allowance. `begin` and `complete` are separated by an unbounded client
  -- upload, so this cannot replace the authoritative check `complete` holds
  -- under `ai-item-credit:<user>`; it only stops a seller copying every object
  -- into an account whose one included run is already spoken for. It reads
  -- without `for update` and takes no credit lock, because an advisory answer
  -- does not earn a global serialization point on every claim start.
  --
  -- Ordering is load-bearing twice over. It runs after the idempotency checks
  -- so a rebind still raises its own 23505, and before the bind below so a
  -- denial leaves the recovery unbound and claimable by another account.
  --
  -- It guards exactly one outcome: minting a fresh copy plan. Every branch that
  -- already answers something else answers it unchanged. A claim that succeeded
  -- or expired replays its terminal outcome rather than being denied by the very
  -- credit it just consumed. A retry arriving while this target's own lease is
  -- still live keeps returning `in_progress`: that call was never going to hand
  -- out a copy plan, so it has no copy to save, and denying a valid in-flight
  -- lease because the account happens to hold an unrelated reservation would
  -- refuse a claim that may still complete. An expired lease falls through,
  -- because the branch below mints a new namespace and that is a fresh plan.
  -- Whatever the account does during the upload stays `complete`'s to answer.
  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() < v_recovery.expires_at
    and not (
      v_recovery.state = 'copying'
      and v_recovery.claim_lease_expires_at > statement_timestamp()
    ) then
    select period.id into v_target_period_id
    from public.ai_item_allowance_periods period
    where period.user_id = p_target_user_id
      and period.source = 'included'
      and period.period_key = 'included-first-run';
    if found then
      perform private.enforce_guest_claim_account_allowance(v_target_period_id);
    end if;
  end if;

  if v_recovery.claim_idempotency_key is null then
    update private.guest_draft_recoveries recovery
    set claim_idempotency_user_id = p_target_user_id,
        claim_idempotency_key = p_idempotency_key,
        updated_at = statement_timestamp()
    where recovery.id = v_recovery.id
    returning * into v_recovery;
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;

  if v_recovery.state = 'copying'
    and v_recovery.claim_lease_expires_at > statement_timestamp() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (
        v_recovery.claim_lease_expires_at - statement_timestamp()
      )))::integer
    );
    return jsonb_build_object(
      'outcome', 'in_progress',
      'retryAfterSeconds', v_retry_after
    );
  end if;

  if v_recovery.state = 'copying' then
    -- A new lease always receives a new destination namespace. Persist cleanup
    -- for the obsolete lease before replacing its only durable authority.
    perform private.queue_guest_claim_copy_cleanup(
      v_recovery,
      v_recovery.claim_target_user_id,
      v_recovery.claim_lease_token
    );
  end if;

  update private.guest_draft_recoveries recovery
  set state = 'copying',
      claim_target_user_id = p_target_user_id,
      claim_lease_token = gen_random_uuid(),
      claim_lease_expires_at = statement_timestamp()
        + make_interval(secs => p_claim_lease_seconds),
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
  returning * into v_recovery;

  select jsonb_agg(
    jsonb_build_object(
      'sourcePath', entry.value->>'sourcePath',
      'destinationPath', p_target_user_id || '/guest-claims/'
        || v_recovery.id::text || '/' || v_recovery.claim_lease_token::text
        || '/' || entry.ordinality::text,
      'sha256', entry.value->>'sha256',
      'byteLength', (entry.value->>'byteLength')::bigint,
      'encryption', entry.value->'encryption'
    ) order by entry.ordinality
  ) into v_objects
  from jsonb_array_elements(v_recovery.storage_manifest)
    with ordinality entry(value, ordinality);

  return jsonb_build_object(
    'outcome', 'copy_required',
    'claimLeaseToken', v_recovery.claim_lease_token,
    'expiresAt', v_recovery.expires_at,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'objects', v_objects
  );
end;
$$;

revoke all on function public.begin_guest_draft_claim(
  uuid, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.begin_guest_draft_claim(
  uuid, text, text, text, uuid, integer
) to service_role;

create or replace function public.complete_guest_draft_claim(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_claim_lease_token uuid,
  p_verified_objects jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_guest_period public.ai_item_allowance_periods%rowtype;
  v_target_period public.ai_item_allowance_periods%rowtype;
  v_expected_objects jsonb;
  v_destination_paths text[];
  v_new_fingerprint text;
  v_lock_user text;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;
  if v_recovery.state <> 'copying'
    or v_recovery.claim_target_user_id is distinct from p_target_user_id
    or v_recovery.claim_lease_token is distinct from p_claim_lease_token
    or v_recovery.claim_lease_expires_at <= statement_timestamp() then
    raise exception using errcode = '55000', message = 'Guest claim lease is stale';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'destinationPath', p_target_user_id || '/guest-claims/'
        || v_recovery.id::text || '/' || p_claim_lease_token::text
        || '/' || entry.ordinality::text,
      'sha256', entry.value->>'sha256',
      'byteLength', (entry.value->>'byteLength')::bigint,
      'encryption', entry.value->'encryption'
    ) order by entry.ordinality
  ) into v_expected_objects
  from jsonb_array_elements(v_recovery.storage_manifest)
    with ordinality entry(value, ordinality);
  if jsonb_typeof(p_verified_objects) is distinct from 'array'
    or p_verified_objects is distinct from v_expected_objects then
    raise exception using
      errcode = '23514',
      message = 'Every account Storage object must be copied and verified';
  end if;

  -- Retention takes this scheduler-neutral lock before item/run/reservation.
  -- Claim follows that order; retention's try-lock simply skips while claim wins.
  perform pg_advisory_xact_lock(
    hashtextextended('snaplist:pipeline-retention', 0)
  );
  for v_lock_user in
    select value
    from unnest(array[v_recovery.guest_user_id, p_target_user_id]) value
    order by value
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('ai-item-credit:' || v_lock_user, 0)
    );
  end loop;

  perform item.id
  from public.items item
  where item.id = v_recovery.item_id
    and item.user_id = v_recovery.guest_user_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Guest item ownership changed';
  end if;

  perform run.id
  from public.pipeline_runs run
  where run.id = v_recovery.pipeline_run_id
    and run.item_id = v_recovery.item_id
    and run.user_id = v_recovery.guest_user_id
    and run.status = 'succeeded'
  order by run.id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Guest run ownership changed';
  end if;

  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.id = v_recovery.reservation_id
    and reservation.pipeline_run_id = v_recovery.pipeline_run_id
    and reservation.item_id = v_recovery.item_id
    and reservation.user_id = v_recovery.guest_user_id
    and reservation.state = 'settled'
    and reservation.listing_id = v_recovery.draft_id
    and (
      reservation.guided_correction_started_at is null
      or reservation.guided_correction_completed_at is not null
    )
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Settled guest credit changed';
  end if;

  if exists (
    select 1 from public.messages message
    where message.item_id = v_recovery.item_id
      and message.user_id = v_recovery.guest_user_id
  ) or exists (
    select 1 from public.embeddings embedding
    where embedding.item_id = v_recovery.item_id
      and embedding.user_id = v_recovery.guest_user_id
  ) or exists (
    select 1 from public.reprice_suggestions suggestion
    where suggestion.item_id = v_recovery.item_id
      and suggestion.user_id = v_recovery.guest_user_id
  ) or exists (
    select 1 from public.message_policy_decisions decision
    where decision.listing_id = v_recovery.draft_id
      and decision.user_id = v_recovery.guest_user_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Guest claim contains unsupported post-draft records';
  end if;

  perform draft.id
    from public.listings draft
    join public.items item
      on item.id = draft.item_id
     and item.user_id = draft.user_id
    join public.prediction_logs prediction
      on prediction.run_id = draft.run_id
     and prediction.item_id = v_recovery.item_id
     and prediction.user_id = v_recovery.guest_user_id
    where draft.id = v_recovery.draft_id
      and draft.item_id = v_recovery.item_id
      and draft.user_id = v_recovery.guest_user_id
      and draft.status in ('draft', 'queued')
      and draft.ebay_listing_id is null
      and draft.ebay_status is distinct from 'publishing'
      and draft.ebay_status is distinct from 'published'
      and jsonb_typeof(item.attributes) = 'object'
      and item.attributes <> '{}'::jsonb
      and jsonb_typeof(item.identification) = 'object'
      and item.review_revision is not distinct from item.review_content_revision
      and draft.source_review_revision is not distinct from item.review_revision
      and prediction.price > 0
      and jsonb_typeof(prediction.price_range) = 'object'
      and prediction.confidence between 0 and 1
      and coalesce(btrim(prediction.tier_fired), '') <> ''
      and jsonb_typeof(prediction.sources) = 'array'
      and (
        jsonb_array_length(prediction.sources) > 0
        or prediction.tier_fired = 'llm-only'
      )
      and draft.platform = 'ebay'
      and coalesce(btrim(draft.title), '') <> ''
      and char_length(draft.title) <= 80
      and coalesce(btrim(draft.description), '') <> ''
      and exists (
        select 1
        from public.prediction_logs settled_prediction
        where settled_prediction.id = v_reservation.prediction_log_id
          and settled_prediction.run_id = v_recovery.pipeline_run_id
          and settled_prediction.item_id = v_recovery.item_id
          and settled_prediction.user_id = v_recovery.guest_user_id
      )
  for update of draft, prediction;
  if not found then
    raise exception using errcode = '55000', message = 'Guest draft is no longer claimable';
  end if;

  set constraints
    public.listings_item_user_fkey,
    public.pipeline_runs_item_user_fkey,
    public.pipeline_runs_listing_item_user_fkey,
    public.notifications_source_pipeline_run_user_fkey,
    public.ai_item_credit_reservations_period_fkey,
    public.ai_item_credit_reservations_pipeline_run_fkey
  deferred;

  select * into v_guest_period
  from public.ai_item_allowance_periods period
  where period.id = v_reservation.allowance_period_id
    and period.user_id = v_recovery.guest_user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Guest included allowance changed';
  end if;

  select * into v_target_period
  from public.ai_item_allowance_periods period
  where period.user_id = p_target_user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;
  if found then
    -- Issue #504: the authoritative check keeps this placement, this row lock
    -- and this lock order. Only the answer changed: `settled` is permanent and
    -- `reserved` is a run that may yet be restored, and one 23505 could not
    -- tell the seller which one they hit.
    perform private.enforce_guest_claim_account_allowance(v_target_period.id);
  else
    if exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.allowance_period_id = v_guest_period.id
        and reservation.id <> v_reservation.id
    ) then
      -- Preserve restored guest attempts on their original accounting period.
      -- This creates only the canonical account period container; the exact
      -- settled reservation below immediately consumes it. No reservation or
      -- spendable credit event is created.
      insert into public.ai_item_allowance_periods (
        user_id,
        source,
        period_key,
        period_start,
        expires_date,
        state,
        allowance
      ) values (
        p_target_user_id,
        'included',
        'included-first-run',
        '-infinity'::timestamptz,
        'infinity'::timestamptz,
        'active',
        1
      )
      on conflict (user_id, source, period_key) do nothing;

      select * into v_target_period
      from public.ai_item_allowance_periods period
      where period.user_id = p_target_user_id
        and period.source = 'included'
        and period.period_key = 'included-first-run'
      for update;
      if not found then
        raise exception using
          errcode = '55000',
          message = 'Account included allowance could not be bound';
      end if;
    else
      update public.ai_item_allowance_periods period
      set user_id = p_target_user_id,
          updated_at = statement_timestamp()
      where period.id = v_guest_period.id
      returning * into v_target_period;
    end if;
  end if;

  perform set_config(
    'snaplist.guest_claim_recovery_id', v_recovery.id::text, true
  );
  perform set_config(
    'snaplist.guest_claim_lease_token', p_claim_lease_token::text, true
  );

  v_destination_paths := private.guest_manifest_destination_paths(
    v_recovery.storage_manifest,
    v_recovery.id,
    p_target_user_id,
    p_claim_lease_token
  );
  v_new_fingerprint := encode(
    sha256(convert_to(array_to_json(v_destination_paths)::text, 'UTF8')),
    'hex'
  );

  update public.items item
  set user_id = p_target_user_id,
      photos = v_destination_paths
  where item.id = v_recovery.item_id
    and item.user_id = v_recovery.guest_user_id;

  update public.pipeline_runs run
  set user_id = p_target_user_id
  where run.id = v_recovery.pipeline_run_id
    and run.user_id = v_recovery.guest_user_id;

  update public.listings draft
  set user_id = p_target_user_id
  where draft.id = v_recovery.draft_id
    and draft.user_id = v_recovery.guest_user_id;

  update public.prediction_logs prediction
  set user_id = p_target_user_id
  where prediction.item_id = v_recovery.item_id
    and prediction.user_id = v_recovery.guest_user_id;

  update public.notifications notification
  set user_id = p_target_user_id
  where notification.source_pipeline_run_id = v_recovery.pipeline_run_id
    and notification.user_id = v_recovery.guest_user_id;

  update private.pipeline_run_usage_reservations usage
  set user_id = p_target_user_id
  where usage.run_id = v_recovery.pipeline_run_id
    and usage.user_id = v_recovery.guest_user_id;

  update public.ai_item_credit_reservations reservation
  set user_id = p_target_user_id,
      allowance_period_id = v_target_period.id,
      photo_set_fingerprint = v_new_fingerprint,
      updated_at = statement_timestamp()
  where reservation.id = v_recovery.reservation_id
    and reservation.state = 'settled';

  if v_target_period.id <> v_guest_period.id then
    delete from public.ai_item_allowance_periods period
    where period.id = v_guest_period.id
      and not exists (
        select 1
        from public.ai_item_credit_reservations reservation
        where reservation.allowance_period_id = period.id
      );
  end if;

  perform private.queue_guest_recovery_storage_cleanup(v_recovery);

  update private.guest_draft_recoveries recovery
  set state = 'claimed',
      claimed_lease_token = p_claim_lease_token,
      claim_lease_token = null,
      claim_lease_expires_at = null,
      storage_manifest = null,
      claimed_storage_manifest = p_verified_objects,
      claimed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
    and recovery.state = 'copying'
    and recovery.claim_lease_token = p_claim_lease_token
  returning * into v_recovery;
  if not found then
    raise exception using errcode = '55000', message = 'Guest claim lost its lease';
  end if;

  return private.guest_terminal_outcome_for_target(
    v_recovery, p_target_user_id
  );
end;
$$;

revoke all on function public.complete_guest_draft_claim(
  uuid, text, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_guest_draft_claim(
  uuid, text, text, uuid, jsonb
) to service_role;

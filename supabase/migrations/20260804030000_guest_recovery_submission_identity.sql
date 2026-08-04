-- Issue #638: carry a client-minted guest recovery identity from the verified
-- mobile submission into the durable pipeline run. The server stores only the
-- SHA-256 token hash; the raw recovery token never enters Postgres.

alter table private.mobile_item_submissions
  add column recovery_id uuid,
  add column recovery_token_hash text,
  add constraint mobile_item_submissions_recovery_identity_check check (
    (recovery_id is null and recovery_token_hash is null)
    or (
      recovery_id is not null
      and recovery_token_hash ~ '^[0-9a-f]{64}$'
    )
  );

create unique index mobile_item_submissions_recovery_id_key
  on private.mobile_item_submissions (recovery_id)
  where recovery_id is not null;

alter table public.pipeline_runs
  add column recovery_id uuid,
  add column recovery_token_hash text,
  add constraint pipeline_runs_recovery_identity_check check (
    (recovery_id is null and recovery_token_hash is null)
    or (
      recovery_id is not null
      and recovery_token_hash ~ '^[0-9a-f]{64}$'
    )
  );

create unique index pipeline_runs_recovery_id_key
  on public.pipeline_runs (recovery_id)
  where recovery_id is not null;

comment on column private.mobile_item_submissions.recovery_token_hash is
  'SHA-256 hash of the client-held guest recovery token. Raw tokens are forbidden.';
comment on column public.pipeline_runs.recovery_token_hash is
  'SHA-256 hash of the client-held guest recovery token. Raw tokens are forbidden.';

create or replace function private.protect_pipeline_run_recovery_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recovery_id is not distinct from old.recovery_id
    and new.recovery_token_hash is not distinct from old.recovery_token_hash then
    return new;
  end if;
  if old.recovery_id is not null
    or old.recovery_token_hash is not null
    or current_user not in ('postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Pipeline run guest recovery identity is immutable';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_pipeline_run_recovery_identity()
  from public, anon, authenticated, service_role;

create trigger pipeline_runs_protect_recovery_identity
before update of recovery_id, recovery_token_hash on public.pipeline_runs
for each row execute function private.protect_pipeline_run_recovery_identity();

create or replace function private.assert_guest_recovery_submission_binding(
  p_user_id text,
  p_idempotency_key uuid,
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_require_row boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission private.mobile_item_submissions%rowtype;
begin
  if p_recovery_id is null
    or p_recovery_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery submission identity is required';
  end if;

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = p_user_id
    and submission.idempotency_key = p_idempotency_key
  for update;

  if not found then
    if p_require_row then
      raise exception using
        errcode = '23514',
        message = 'Guest recovery submission binding is missing';
    end if;
    return;
  end if;

  if v_submission.recovery_id is distinct from p_recovery_id
    or v_submission.recovery_token_hash is distinct from p_recovery_token_hash then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;
end;
$$;

revoke all on function private.assert_guest_recovery_submission_binding(
  text, uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.find_mobile_item_submission_v3(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_recovery_id uuid,
  p_recovery_token_hash text
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  voice_receipt jsonb,
  is_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recovery_id is not null or p_recovery_token_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'Authenticated submissions cannot carry guest recovery identity';
  end if;
  return query select * from public.find_mobile_item_submission_v2(
    p_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_legacy_request_fingerprint
  );
end;
$$;

create or replace function public.find_mobile_item_submission_v3(
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_recovery_id uuid,
  p_recovery_token_hash text
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  voice_receipt jsonb,
  is_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
begin
  perform private.assert_guest_recovery_submission_binding(
    v_user_id,
    p_idempotency_key,
    p_recovery_id,
    p_recovery_token_hash,
    false
  );
  return query select * from public.find_mobile_item_submission_v2(
    p_idempotency_key,
    p_request_fingerprint,
    p_legacy_request_fingerprint
  );
end;
$$;

create or replace function public.begin_mobile_item_submission_v3(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_photo_receipts jsonb,
  p_voice_receipt jsonb,
  p_recovery_id uuid,
  p_recovery_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recovery_id is not null or p_recovery_token_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'Authenticated submissions cannot carry guest recovery identity';
  end if;
  return public.begin_mobile_item_submission_v2(
    p_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_legacy_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_photo_receipts,
    p_voice_receipt
  );
end;
$$;

create or replace function public.begin_mobile_item_submission_v3(
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_photo_receipts jsonb,
  p_voice_receipt jsonb,
  p_recovery_id uuid,
  p_recovery_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
  v_created boolean;
begin
  if p_recovery_id is null
    or p_recovery_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery submission identity is required';
  end if;

  v_created := public.begin_mobile_item_submission_v2(
    p_idempotency_key,
    p_request_fingerprint,
    p_legacy_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_photo_receipts,
    p_voice_receipt
  );

  update private.mobile_item_submissions submission
  set recovery_id = p_recovery_id,
      recovery_token_hash = p_recovery_token_hash
  where submission.user_id = v_user_id
    and submission.idempotency_key = p_idempotency_key
    and (
      (submission.recovery_id is null and submission.recovery_token_hash is null)
      or (
        submission.recovery_id = p_recovery_id
        and submission.recovery_token_hash = p_recovery_token_hash
      )
    );
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;
  return v_created;
end;
$$;

create or replace function public.commit_mobile_item_submission_v3(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_daily_limit integer,
  p_per_minute_limit integer,
  p_photo_identity jsonb,
  p_photo_receipts jsonb,
  p_voice_receipt jsonb,
  p_recovery_id uuid,
  p_recovery_token_hash text
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  voice_receipt jsonb,
  is_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recovery_id is not null or p_recovery_token_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'Authenticated submissions cannot carry guest recovery identity';
  end if;
  return query select * from public.commit_mobile_item_submission_v2(
    p_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_legacy_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_daily_limit,
    p_per_minute_limit,
    p_photo_identity,
    p_photo_receipts,
    p_voice_receipt
  );
end;
$$;

create or replace function public.commit_mobile_item_submission_v3(
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_daily_limit integer,
  p_per_minute_limit integer,
  p_photo_identity jsonb,
  p_photo_receipts jsonb,
  p_voice_receipt jsonb,
  p_recovery_id uuid,
  p_recovery_token_hash text
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  voice_receipt jsonb,
  is_replay boolean,
  denial_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
  v_committed record;
begin
  perform private.assert_guest_recovery_submission_binding(
    v_user_id,
    p_idempotency_key,
    p_recovery_id,
    p_recovery_token_hash,
    true
  );

  select committed.* into v_committed
  from public.commit_mobile_item_submission_v2(
    p_idempotency_key,
    p_request_fingerprint,
    p_legacy_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_daily_limit,
    p_per_minute_limit,
    p_photo_identity,
    p_photo_receipts,
    p_voice_receipt
  ) committed;

  if v_committed.denial_reason is null then
    update public.pipeline_runs run
    set recovery_id = p_recovery_id,
        recovery_token_hash = p_recovery_token_hash
    where run.id = v_committed.run_id
      and run.user_id = v_user_id
      and (
        (run.recovery_id is null and run.recovery_token_hash is null)
        or (
          run.recovery_id = p_recovery_id
          and run.recovery_token_hash = p_recovery_token_hash
        )
      );
    if not found then
      raise exception using
        errcode = '23514',
        message = 'Pipeline run guest recovery identity conflicts';
    end if;
  end if;

  item_id := v_committed.item_id;
  run_id := v_committed.run_id;
  queue_message_id := v_committed.queue_message_id;
  photo_identity_kind := v_committed.photo_identity_kind;
  photo_identity_fingerprint := v_committed.photo_identity_fingerprint;
  photo_receipts := v_committed.photo_receipts;
  voice_receipt := v_committed.voice_receipt;
  is_replay := v_committed.is_replay;
  denial_reason := v_committed.denial_reason;
  return next;
end;
$$;

revoke all on function public.find_mobile_item_submission_v2(
  text, uuid, text, text
) from service_role;
revoke all on function public.find_mobile_item_submission_v2(
  uuid, text, text
) from authenticated;
revoke all on function public.begin_mobile_item_submission_v2(
  text, uuid, text, text, uuid, uuid, numeric, jsonb, jsonb
) from service_role;
revoke all on function public.begin_mobile_item_submission_v2(
  uuid, text, text, uuid, uuid, numeric, jsonb, jsonb
) from authenticated;
revoke all on function public.commit_mobile_item_submission_v2(
  text, uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb
) from service_role;
revoke all on function public.commit_mobile_item_submission_v2(
  uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb
) from authenticated;

-- Retire every pre-v3 producer entry point. Keeping any old overload callable
-- would let a guest or legacy server enqueue paid work without the mandatory
-- recovery identity, only to fail closed after provider execution.
revoke all on function public.find_mobile_item_submission(text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.find_mobile_item_submission(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.begin_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.begin_mobile_item_submission(
  uuid, text, uuid, uuid, numeric, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.commit_mobile_item_submission(
  uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.find_mobile_item_submission_v3(
  text, uuid, text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.find_mobile_item_submission_v3(
  text, uuid, text, text, uuid, text
) to service_role;
revoke all on function public.find_mobile_item_submission_v3(
  uuid, text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.find_mobile_item_submission_v3(
  uuid, text, text, uuid, text
) to authenticated;

revoke all on function public.begin_mobile_item_submission_v3(
  text, uuid, text, text, uuid, uuid, numeric, jsonb, jsonb, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_mobile_item_submission_v3(
  text, uuid, text, text, uuid, uuid, numeric, jsonb, jsonb, uuid, text
) to service_role;
revoke all on function public.begin_mobile_item_submission_v3(
  uuid, text, text, uuid, uuid, numeric, jsonb, jsonb, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_mobile_item_submission_v3(
  uuid, text, text, uuid, uuid, numeric, jsonb, jsonb, uuid, text
) to authenticated;

revoke all on function public.commit_mobile_item_submission_v3(
  text, uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.commit_mobile_item_submission_v3(
  text, uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb, uuid, text
) to service_role;
revoke all on function public.commit_mobile_item_submission_v3(
  uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.commit_mobile_item_submission_v3(
  uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb, uuid, text
) to authenticated;

-- The acquired context remains run-scoped. It exposes only the already-owned
-- run identity and immutable item photo identity needed by the recovery
-- producer; it does not grant a generic table client to the worker.
create or replace function private.pipeline_worker_context_json(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'run', jsonb_build_object(
      'id', run.id,
      'user_id', run.user_id,
      'item_id', run.item_id,
      'listing_id', run.listing_id,
      'status', run.status,
      'stage', run.stage,
      'schema_version', run.schema_version,
      'attempt_count', run.attempt_count,
      'max_attempts', run.max_attempts,
      'autopilot_enabled', coalesce(
        (to_jsonb(run) #>> '{capture_input,autopilot_enabled}')::boolean,
        run.autopilot_enabled
      ),
      'checkpoint', run.checkpoint,
      'lease_token', run.lease_token,
      'lease_expires_at', run.lease_expires_at,
      'next_attempt_at', run.next_attempt_at,
      'recovery_id', run.recovery_id,
      'recovery_token_hash', run.recovery_token_hash
    ),
    'item', jsonb_build_object(
      'id', item.id,
      'user_id', item.user_id,
      'photos', item.photos,
      'photo_identity_kind', item.photo_identity_kind,
      'photo_identity_fingerprint', item.photo_identity_fingerprint,
      'attributes', item.attributes,
      'condition', item.condition,
      'cost_basis', item.cost_basis,
      'review_revision', item.review_revision,
      'review_content_revision', item.review_content_revision
    )
  )
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  where run.id = p_run_id;
$$;

revoke all on function private.pipeline_worker_context_json(uuid)
  from public, anon, authenticated, service_role;

-- The only completion-time photo mutation is a storage-address remap from the
-- immutable submitted bytes to their encrypted recovery envelopes. It is tied
-- to the acquired run lease and the already-staged exact cleanup manifest; the
-- item identity and every credit-ledger field remain unchanged.
create or replace function private.guest_recovery_photo_remap_allowed(
  p_old public.items,
  p_new public.items
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run_id text := current_setting('snaplist.guest_recovery_run_id', true);
  v_recovery_id text := current_setting(
    'snaplist.guest_recovery_recovery_id', true
  );
  v_lease_token text := current_setting(
    'snaplist.guest_recovery_lease_token', true
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role'
    or coalesce(v_run_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(v_recovery_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(v_lease_token, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or cardinality(p_old.photos) not between 1 and 5
    or cardinality(p_new.photos) is distinct from cardinality(p_old.photos)
    or (to_jsonb(p_new) - array['photos', 'updated_at']::text[])
      is distinct from (
        to_jsonb(p_old) - array['photos', 'updated_at']::text[]
      ) then
    return false;
  end if;

  return exists (
    select 1
    from public.pipeline_runs run
    join private.pipeline_storage_cleanup_jobs cleanup
      on cleanup.source_type = 'guest_recovery'
     and cleanup.source_id = run.recovery_id
     and cleanup.state = 'pending'
     and cleanup.photo_paths is not distinct from p_new.photos
    where run.id = v_run_id::uuid
      and run.item_id = p_old.id
      and run.user_id = p_old.user_id
      and run.status = 'succeeded'
      and run.stage = 'completed'
      and run.completed_at = statement_timestamp()
      and run.lease_token is null
      and run.lease_expires_at is null
      and run.recovery_id = v_recovery_id::uuid
      and run.recovery_token_hash ~ '^[0-9a-f]{64}$'
      and not exists (
        select 1
        from unnest(p_new.photos) path
        where left(
          path,
          char_length(run.user_id || '/guest-recovery/' || run.recovery_id::text || '/')
        ) <> run.user_id || '/guest-recovery/' || run.recovery_id::text || '/'
      )
  );
end;
$$;

revoke all on function private.guest_recovery_photo_remap_allowed(
  public.items, public.items
) from public, anon, authenticated, service_role;

create or replace function private.enforce_credited_item_photo_set_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_set_fingerprint text;
begin
  if new.photos is not distinct from old.photos then
    return new;
  end if;

  perform reservation.id
  from public.ai_item_credit_reservations reservation
  where reservation.item_id = old.id
    and reservation.user_id = old.user_id
  order by reservation.pipeline_run_id
  for update of reservation;

  if not found then
    return new;
  end if;

  if private.guest_claim_photo_remap_allowed(old, new)
    or private.guest_recovery_photo_remap_allowed(old, new) then
    return new;
  end if;

  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(old.photos)::text, 'UTF8')),
    'hex'
  );

  if new.photos = '{}'::text[]
    and not exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.item_id = old.id
        and reservation.user_id = old.user_id
        and (
          reservation.state = 'reserved'
          or reservation.photo_set_fingerprint
            is distinct from v_photo_set_fingerprint
        )
    )
    and exists (
      select 1
      from private.pipeline_storage_cleanup_jobs cleanup_job
      where cleanup_job.source_type in ('abandoned_item', 'guest_recovery')
        and (
          (cleanup_job.source_type = 'abandoned_item'
            and cleanup_job.source_id = old.id)
          or (
            cleanup_job.source_type = 'guest_recovery'
            and exists (
              select 1
              from private.guest_draft_recoveries recovery
              where recovery.id = cleanup_job.source_id
                and recovery.item_id = old.id
                and recovery.guest_user_id = old.user_id
            )
          )
        )
        and (
          (cleanup_job.source_type = 'abandoned_item'
            and cleanup_job.photo_paths is not distinct from old.photos)
          or (
            cleanup_job.source_type = 'guest_recovery'
            and cleanup_job.photo_paths @> old.photos
          )
        )
        and cleanup_job.xmin = pg_current_xact_id()::xid
    ) then
    return new;
  end if;

  raise exception using
    errcode = '23514',
    message = 'A credited item photo set is immutable; start a new AI-item run';
end;
$$;

revoke all on function private.enforce_credited_item_photo_set_immutable()
  from public, anon, authenticated, service_role;

-- Internal overload for the producer. The extra source-path argument proves
-- the encrypted manifest replaced the exact run-owned photo set and supplies
-- bounded deletion authority for the superseded plaintext Storage objects.
create or replace function public.register_guest_draft_recovery(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_pipeline_run_id uuid,
  p_recovery_token_hash text,
  p_encrypted_artifact jsonb,
  p_storage_manifest jsonb,
  p_source_photo_paths text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_recovery private.guest_draft_recoveries%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_object jsonb;
  v_recovery_paths text[];
  v_distinct_paths integer;
  v_distinct_nonces integer;
begin
  perform private.guest_claim_service_role_required();

  if p_recovery_id is null
    or p_pipeline_run_id is null
    or coalesce(char_length(p_guest_user_id), 0) not between 1 and 255
    or p_guest_user_id !~ '^guest_[0-9a-f]{48}$'
    or coalesce(p_recovery_token_hash, '') !~ '^[0-9a-f]{64}$'
    or cardinality(p_source_photo_paths) not between 1 and 5
    or jsonb_typeof(p_encrypted_artifact) is distinct from 'object'
    or p_encrypted_artifact - array[
      'version', 'algorithm', 'keyId', 'keyEnvelope', 'nonce', 'tag', 'ciphertext'
    ]::text[] <> '{}'::jsonb
    or not p_encrypted_artifact ?& array[
      'version', 'algorithm', 'keyId', 'keyEnvelope', 'nonce', 'tag', 'ciphertext'
    ]
    or p_encrypted_artifact->>'version' <> '1'
    or p_encrypted_artifact->>'algorithm' <> 'aes-256-gcm'
    or coalesce(p_encrypted_artifact->>'keyId', '') !~ '^[A-Za-z0-9_-]{1,128}$'
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'keyEnvelope',
      p_min_bytes => 1,
      p_max_bytes => 65536
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'nonce',
      p_exact_bytes => 12
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'tag',
      p_exact_bytes => 16
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'ciphertext',
      p_min_bytes => 1,
      p_max_bytes => 2097152
    ), false)
    or pg_column_size(p_encrypted_artifact) > 2 * 1024 * 1024
    or jsonb_typeof(p_storage_manifest) is distinct from 'array'
    or jsonb_array_length(p_storage_manifest) is distinct from cardinality(p_source_photo_paths)
    or jsonb_array_length(p_storage_manifest) not between 1 and 5 then
    raise exception using
      errcode = '22023',
      message = 'Invalid encrypted guest recovery artifact';
  end if;

  for v_object in
    select entry.value
    from jsonb_array_elements(p_storage_manifest) entry(value)
  loop
    if jsonb_typeof(v_object) is distinct from 'object'
      or v_object - array[
        'sourcePath', 'sha256', 'byteLength', 'encryption'
      ]::text[] <> '{}'::jsonb
      or not v_object ?& array[
        'sourcePath', 'sha256', 'byteLength', 'encryption'
      ]
      or jsonb_typeof(v_object->'sourcePath') is distinct from 'string'
      or jsonb_typeof(v_object->'sha256') is distinct from 'string'
      or jsonb_typeof(v_object->'byteLength') is distinct from 'number'
      or jsonb_typeof(v_object->'encryption') is distinct from 'object'
      or (v_object->'encryption') - array[
        'algorithm', 'keyId', 'nonce', 'tag'
      ]::text[] <> '{}'::jsonb
      or not (v_object->'encryption') ?& array[
        'algorithm', 'keyId', 'nonce', 'tag'
      ]
      or v_object->'encryption'->>'algorithm' <> 'aes-256-gcm'
      or v_object->'encryption'->>'keyId' <> p_encrypted_artifact->>'keyId'
      or not coalesce(private.valid_guest_base64(
        v_object->'encryption'->>'nonce',
        p_exact_bytes => 12
      ), false)
      or not coalesce(private.valid_guest_base64(
        v_object->'encryption'->>'tag',
        p_exact_bytes => 16
      ), false)
      or left(
        v_object->>'sourcePath',
        char_length(p_guest_user_id || '/guest-recovery/' || p_recovery_id::text || '/')
      ) <> p_guest_user_id || '/guest-recovery/' || p_recovery_id::text || '/'
      or char_length(v_object->>'sourcePath') <= char_length(
        p_guest_user_id || '/guest-recovery/' || p_recovery_id::text || '/'
      )
      or v_object->>'sourcePath' like '%://%'
      or v_object->>'sourcePath' ~ '[?#]'
      or v_object->>'sourcePath' ~ '(^|/)\.\.?(/|$)'
      or char_length(v_object->>'sourcePath') > 1024
      or coalesce(v_object->>'sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_object->>'byteLength', '') !~ '^[0-9]+$'
      or (v_object->>'byteLength')::bigint not between 1 and 52428837 then
      raise exception using
        errcode = '22023',
        message = 'Invalid private Storage recovery manifest';
    end if;
  end loop;

  v_recovery_paths := private.guest_manifest_source_paths(p_storage_manifest);
  select count(distinct entry.value->>'sourcePath')
  into v_distinct_paths
  from jsonb_array_elements(p_storage_manifest) entry(value);
  if v_distinct_paths <> cardinality(v_recovery_paths) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery Storage paths must be unique';
  end if;
  select count(distinct entry.value->'encryption'->>'nonce')
  into v_distinct_nonces
  from jsonb_array_elements(p_storage_manifest) entry(value);
  if v_distinct_nonces <> jsonb_array_length(p_storage_manifest)
    or exists (
      select 1
      from jsonb_array_elements(p_storage_manifest) entry(value)
      where entry.value->'encryption'->>'nonce' = p_encrypted_artifact->>'nonce'
    ) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery AES-GCM nonces must be unique';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );

  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
  for update;
  if found then
    if v_recovery.pipeline_run_id is distinct from p_pipeline_run_id
      or v_recovery.guest_user_id is distinct from p_guest_user_id
      or v_recovery.recovery_token_hash is distinct from p_recovery_token_hash
      or (
        v_recovery.state in ('claimable', 'copying')
        and (
          v_recovery.encrypted_artifact is distinct from p_encrypted_artifact
          or v_recovery.storage_manifest is distinct from p_storage_manifest
        )
      ) then
      raise exception using
        errcode = '23514',
        message = 'Guest recovery registration identity conflicts';
    end if;
    if v_recovery.state in ('claimed', 'expired') then
      return private.guest_terminal_outcome(v_recovery);
    end if;
    if statement_timestamp() >= v_recovery.expires_at then
      v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
      return private.guest_terminal_outcome(v_recovery);
    end if;
    return jsonb_build_object(
      'outcome', 'recoverable',
      'recoveryId', v_recovery.id,
      'itemId', v_recovery.item_id,
      'runId', v_recovery.pipeline_run_id,
      'draftId', v_recovery.draft_id,
      'usableDraftAt', v_recovery.usable_draft_at,
      'expiresAt', v_recovery.expires_at,
      'encryptedArtifact', v_recovery.encrypted_artifact,
      'purgeLocalRecovery', false
    );
  end if;

  if exists (
    select 1
    from private.guest_draft_recoveries recovery
    where recovery.pipeline_run_id = p_pipeline_run_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Guest recovery run is already registered';
  end if;

  select * into v_run
  from public.pipeline_runs run
  where run.id = p_pipeline_run_id
    and run.user_id = p_guest_user_id
    and run.recovery_id = p_recovery_id
    and run.recovery_token_hash = p_recovery_token_hash
    and run.status = 'succeeded'
    and run.stage = 'completed'
    and run.completed_at is not null
    and run.listing_id is not null
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery requires a durable usable draft';
  end if;

  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = v_run.id
    and reservation.user_id = v_run.user_id
    and reservation.item_id = v_run.item_id
    and reservation.state = 'settled'
    and reservation.listing_id = v_run.listing_id
  for update;
  if not found
    or not exists (
      select 1
      from public.items item
      join public.listings draft
        on draft.id = v_run.listing_id
       and draft.item_id = item.id
       and draft.user_id = item.user_id
      join public.prediction_logs prediction
        on prediction.id = v_reservation.prediction_log_id
       and prediction.run_id = v_run.id
       and prediction.item_id = item.id
       and prediction.user_id = item.user_id
      where item.id = v_run.item_id
        and item.user_id = v_run.user_id
        and item.photos is not distinct from v_recovery_paths
        and cardinality(item.photos) = cardinality(v_recovery_paths)
        and item.photo_identity_kind = 'content_sha256_set_v1'
        and item.photo_identity_fingerprint ~ '^[0-9a-f]{64}$'
        and draft.status in ('draft', 'queued')
        and draft.ebay_listing_id is null
        and draft.ebay_status is distinct from 'publishing'
        and draft.ebay_status is distinct from 'published'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery requires the exact settled draft evidence';
  end if;

  insert into private.guest_draft_recoveries (
    id,
    guest_user_id,
    pipeline_run_id,
    item_id,
    draft_id,
    reservation_id,
    allowance_period_id,
    recovery_token_hash,
    encrypted_artifact,
    storage_manifest,
    storage_object_count,
    usable_draft_at,
    expires_at
  ) values (
    p_recovery_id,
    p_guest_user_id,
    v_run.id,
    v_run.item_id,
    v_run.listing_id,
    v_reservation.id,
    v_reservation.allowance_period_id,
    p_recovery_token_hash,
    p_encrypted_artifact,
    p_storage_manifest,
    jsonb_array_length(p_storage_manifest),
    v_run.completed_at,
    v_run.completed_at + interval '24 hours'
  )
  returning * into v_recovery;

  if statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
    return private.guest_terminal_outcome(v_recovery);
  end if;

  return jsonb_build_object(
    'outcome', 'recoverable',
    'recoveryId', v_recovery.id,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'usableDraftAt', v_recovery.usable_draft_at,
    'expiresAt', v_recovery.expires_at,
    'encryptedArtifact', v_recovery.encrypted_artifact,
    'purgeLocalRecovery', false
  );
end;
$$;

revoke all on function public.register_guest_draft_recovery(
  uuid, text, uuid, text, jsonb, jsonb, text[]
) from public, anon, authenticated, service_role;

-- Establish deletion authority before the worker writes any encrypted copy.
-- A successful registration consumes this pending job atomically; preparation
-- or completion failures leave it for the existing bounded cleanup worker.
create or replace function public.stage_guest_recovery_upload_cleanup(
  p_run_id uuid,
  p_lease_token uuid,
  p_photo_paths text[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_prefix text;
  v_path text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline worker authorization is required';
  end if;

  select run.* into v_run
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  where run.id = p_run_id
    and run.status = 'running'
    and run.lease_token = p_lease_token
    and run.lease_expires_at > now()
    and cardinality(p_photo_paths) = cardinality(item.photos)
  for update of run;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Pipeline worker lease is stale or recovery photo count changed';
  end if;
  if v_run.user_id !~ '^guest_[0-9a-f]{48}$'
    or v_run.recovery_id is null
    or v_run.recovery_token_hash is null then
    raise exception using
      errcode = '23514',
      message = 'Guest recovery upload requires client-held recovery authority';
  end if;
  if cardinality(p_photo_paths) not between 1 and 5
    or cardinality(array(select distinct path from unnest(p_photo_paths) path))
      <> cardinality(p_photo_paths) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery upload cleanup paths are invalid';
  end if;

  v_prefix := v_run.user_id || '/guest-recovery/' || v_run.recovery_id::text || '/';
  foreach v_path in array p_photo_paths loop
    if v_path is null
      or char_length(v_path) <= char_length(v_prefix)
      or char_length(v_path) > 1024
      or left(v_path, char_length(v_prefix)) <> v_prefix
      or v_path like '%://%'
      or v_path ~ '[?#]'
      or v_path ~ '(^|/)\.\.?(/|$)' then
      raise exception using
        errcode = '22023',
        message = 'Guest recovery upload cleanup paths are invalid';
    end if;
  end loop;

  insert into private.pipeline_storage_cleanup_jobs as cleanup (
    source_type,
    source_id,
    photo_paths,
    available_at
  ) values (
    'guest_recovery',
    v_run.recovery_id,
    p_photo_paths,
    v_run.lease_expires_at + interval '5 minutes'
  )
  on conflict (source_type, source_id) do update
  set available_at = excluded.available_at,
      updated_at = statement_timestamp()
  where cleanup.state = 'pending'
    and cleanup.photo_paths is not distinct from excluded.photo_paths;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery upload cleanup is already in progress';
  end if;
  return true;
end;
$$;

revoke all on function public.stage_guest_recovery_upload_cleanup(
  uuid, uuid, text[]
) from public, anon, authenticated, service_role;
grant execute on function public.stage_guest_recovery_upload_cleanup(
  uuid, uuid, text[]
) to service_role;

create or replace function public.complete_pipeline_run_with_guest_recovery(
  p_run_id uuid,
  p_lease_token uuid,
  p_persistence jsonb,
  p_guest_recovery_registration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_completion jsonb;
  v_manifest jsonb;
  v_recovery jsonb;
  v_recovery_paths text[];
  v_source_photo_paths text[];
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline worker authorization is required';
  end if;

  select run.* into v_run
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.status = 'running'
    and run.lease_token = p_lease_token
    and run.lease_expires_at > now()
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Pipeline worker lease is stale';
  end if;

  select item.photos into v_source_photo_paths
  from public.items item
  where item.id = v_run.item_id
    and item.user_id = v_run.user_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'Pipeline run item ownership changed';
  end if;

  if v_run.recovery_id is null and v_run.recovery_token_hash is null then
    if v_run.user_id ~ '^guest_[0-9a-f]{48}$' then
      raise exception using
        errcode = '23514',
        message = 'Legacy guest pipeline run has no recovery authority';
    end if;
    if p_guest_recovery_registration is not null then
      raise exception using
        errcode = '22023',
        message = 'Authenticated pipeline runs cannot register guest recovery';
    end if;
  elsif v_run.recovery_id is null or v_run.recovery_token_hash is null then
    raise exception using
      errcode = '23514',
      message = 'Pipeline run guest recovery identity is incomplete';
  else
    if jsonb_typeof(p_guest_recovery_registration) is distinct from 'object'
      or p_guest_recovery_registration->>'recoveryId'
        is distinct from v_run.recovery_id::text
      or p_guest_recovery_registration->>'guestUserId'
        is distinct from v_run.user_id
      or p_guest_recovery_registration->>'pipelineRunId'
        is distinct from v_run.id::text
      or p_guest_recovery_registration->>'recoveryTokenHash'
        is distinct from v_run.recovery_token_hash
      or jsonb_typeof(
        p_guest_recovery_registration->'encryptedArtifact'
      ) is distinct from 'object'
      or jsonb_typeof(
        p_guest_recovery_registration->'storageManifest'
      ) is distinct from 'array' then
      raise exception using
        errcode = '22023',
        message = 'Guest recovery registration does not match the acquired run';
    end if;
    v_manifest := p_guest_recovery_registration->'storageManifest';
    if jsonb_array_length(v_manifest)
      is distinct from cardinality(v_source_photo_paths) then
      raise exception using
        errcode = '22023',
        message = 'Guest recovery manifest does not match the immutable photo set';
    end if;

    select array_agg(object->>'sourcePath' order by ordinal)
    into v_recovery_paths
    from jsonb_array_elements(v_manifest) with ordinality manifest(object, ordinal)
    where object->>'sourcePath' like
      v_run.user_id || '/guest-recovery/' || v_run.recovery_id::text || '/%';
    if cardinality(v_recovery_paths) is distinct from jsonb_array_length(v_manifest) then
      raise exception using
        errcode = '22023',
        message = 'Guest recovery Storage paths are outside the owned recovery prefix';
    end if;

    perform set_config(
      'snaplist.guest_recovery_run_id', v_run.id::text, true
    );
    perform set_config(
      'snaplist.guest_recovery_recovery_id', v_run.recovery_id::text, true
    );
    perform set_config(
      'snaplist.guest_recovery_lease_token', p_lease_token::text, true
    );
  end if;

  v_completion := public.complete_pipeline_run(
    p_run_id,
    p_lease_token,
    p_persistence
  );

  if v_run.recovery_id is not null then
    update public.items item
    set photos = v_recovery_paths
    where item.id = v_run.item_id
      and item.user_id = v_run.user_id
      and item.photos is not distinct from v_source_photo_paths;
    if not found then
      raise exception using
        errcode = '55000',
        message = 'Guest recovery photo-set remap lost its immutable source';
    end if;

    v_recovery := public.register_guest_draft_recovery(
      v_run.recovery_id,
      v_run.user_id,
      v_run.id,
      v_run.recovery_token_hash,
      p_guest_recovery_registration->'encryptedArtifact',
      v_manifest,
      v_source_photo_paths
    );
    if v_recovery->>'outcome' is distinct from 'recoverable' then
      raise exception using
        errcode = '55000',
        message = 'Guest recovery registration did not become recoverable';
    end if;

    delete from private.pipeline_storage_cleanup_jobs cleanup
    where cleanup.source_type = 'guest_recovery'
      and cleanup.source_id = v_run.recovery_id
      and cleanup.photo_paths is not distinct from v_recovery_paths
      and cleanup.state = 'pending';
    if not found then
      raise exception using
        errcode = '55000',
        message = 'Guest recovery upload cleanup authority is missing';
    end if;

    insert into private.pipeline_storage_cleanup_jobs (
      source_type,
      source_id,
      photo_paths,
      available_at
    ) values (
      'staging',
      v_run.recovery_id,
      v_source_photo_paths,
      statement_timestamp()
    );
  end if;

  return v_completion;
end;
$$;

revoke all on function public.complete_pipeline_run(uuid, uuid, jsonb)
  from service_role;
revoke all on function public.complete_pipeline_run_with_guest_recovery(
  uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_pipeline_run_with_guest_recovery(
  uuid, uuid, jsonb, jsonb
) to service_role;

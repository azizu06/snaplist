-- Issue #541: bind one optional validated WAV receipt to the existing durable
-- item-run transaction without changing photo identity, credits, or queue shape.
-- #386 consumes this private handoff and owns deletion execution and proof.

update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'audio/wav')
where id = 'photos'
  and allowed_mime_types is not null
  and not ('audio/wav' = any(allowed_mime_types));

create table private.mobile_item_submission_voice_handoffs (
  user_id text not null,
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_id uuid not null,
  cleanup_id uuid not null,
  receipt jsonb not null,
  state text not null default 'staged'
    check (state in ('staged', 'accepted')),
  item_id uuid,
  run_id uuid,
  cleanup_after timestamptz not null
    default (statement_timestamp() + interval '24 hours'),
  accepted_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (user_id, idempotency_key),
  unique (cleanup_id),
  check (
    (state = 'staged' and item_id is null and run_id is null and accepted_at is null)
    or
    (state = 'accepted' and item_id is not null and run_id is not null and accepted_at is not null)
  )
);

create unique index mobile_item_submission_voice_handoffs_storage_path_key
  on private.mobile_item_submission_voice_handoffs
  ((receipt->>'storage_path'));

revoke all on table private.mobile_item_submission_voice_handoffs
  from public, anon, authenticated, service_role;

create or replace function private.assert_mobile_submission_voice_receipt(
  p_user_id text,
  p_batch_id uuid,
  p_voice_receipt jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_storage_path text;
  v_locale jsonb;
begin
  if p_voice_receipt is null then
    return;
  end if;
  if jsonb_typeof(p_voice_receipt) <> 'object'
    or not (p_voice_receipt ?& array[
      'version',
      'storage_path',
      'content_sha256',
      'byte_length',
      'duration_ms',
      'locale',
      'media_type'
    ])
    or (select count(*) from jsonb_object_keys(p_voice_receipt)) <> 7
    or p_voice_receipt->>'version' is distinct from '1'
    or jsonb_typeof(p_voice_receipt->'version') <> 'number'
    or p_voice_receipt->>'content_sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_voice_receipt->'byte_length') <> 'number'
    or (p_voice_receipt->>'byte_length') !~ '^[0-9]+$'
    or (p_voice_receipt->>'byte_length')::integer not between 1 and 524288
    or jsonb_typeof(p_voice_receipt->'duration_ms') <> 'number'
    or (p_voice_receipt->>'duration_ms') !~ '^[0-9]+$'
    or (p_voice_receipt->>'duration_ms')::integer not between 1 and 15000
    or p_voice_receipt->>'media_type' is distinct from 'audio/wav' then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile submission voice receipt';
  end if;

  v_locale := p_voice_receipt->'locale';
  if jsonb_typeof(v_locale) not in ('string', 'null')
    or (
      jsonb_typeof(v_locale) = 'string'
      and (
        char_length(p_voice_receipt->>'locale') not between 1 and 255
        or p_voice_receipt->>'locale' ~ '[[:cntrl:]]'
      )
    ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile submission voice locale';
  end if;

  v_storage_path := p_voice_receipt->>'storage_path';
  if coalesce(char_length(v_storage_path), 0) < 1
    or char_length(v_storage_path) > 1024
    or left(
      v_storage_path,
      char_length(p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/')
    ) <> p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/'
    or v_storage_path like '%://%'
    or v_storage_path like '%?%'
    or v_storage_path like '%#%' then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile submission voice path';
  end if;
end;
$$;

revoke all on function private.assert_mobile_submission_voice_receipt(
  text, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function private.bind_mobile_submission_voice_handoff(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_voice_receipt jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission private.mobile_item_submissions%rowtype;
  v_handoff private.mobile_item_submission_voice_handoffs%rowtype;
begin
  perform private.assert_mobile_submission_voice_receipt(
    p_user_id, p_batch_id, p_voice_receipt
  );

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = p_user_id
    and submission.idempotency_key = p_idempotency_key
  for update;
  if not found
    or v_submission.request_fingerprint is distinct from p_request_fingerprint
    or v_submission.batch_id is distinct from p_batch_id
    or v_submission.cleanup_id is distinct from p_cleanup_id then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;

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
    return false;
  end if;

  if found then
    if v_handoff.request_fingerprint is distinct from p_request_fingerprint
      or v_handoff.batch_id is distinct from p_batch_id
      or v_handoff.cleanup_id is distinct from p_cleanup_id
      or v_handoff.receipt is distinct from p_voice_receipt then
      raise exception using
        errcode = '23514',
        message = 'Mobile item submission idempotency conflict';
    end if;
    if v_handoff.state = 'staged' then
      update private.mobile_item_submission_voice_handoffs handoff
      set cleanup_after = greatest(
            handoff.cleanup_after,
            statement_timestamp() + interval '24 hours'
          ),
          updated_at = statement_timestamp()
      where handoff.user_id = p_user_id
        and handoff.idempotency_key = p_idempotency_key;
    end if;
    return false;
  end if;

  if v_submission.state is distinct from 'uploading' then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;

  insert into private.mobile_item_submission_voice_handoffs (
    user_id,
    idempotency_key,
    request_fingerprint,
    batch_id,
    cleanup_id,
    receipt
  ) values (
    p_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_voice_receipt
  );
  return true;
end;
$$;

revoke all on function private.bind_mobile_submission_voice_handoff(
  text, uuid, text, uuid, uuid, jsonb
) from public, anon, authenticated, service_role;

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

create or replace function private.resolve_mobile_item_submission_v2_fingerprint(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_allow_legacy boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_allow_legacy
    and p_legacy_request_fingerprint is not null
    and exists (
      select 1
      from private.mobile_item_submissions submission
      where submission.user_id = p_user_id
        and submission.idempotency_key = p_idempotency_key
        and submission.request_fingerprint = p_legacy_request_fingerprint
    ) then
    return p_legacy_request_fingerprint;
  end if;
  return p_request_fingerprint;
end;
$$;

revoke all on function private.resolve_mobile_item_submission_v2_fingerprint(
  text, uuid, text, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.find_mobile_item_submission_v2(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text
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
  v_request_fingerprint text :=
    private.resolve_mobile_item_submission_v2_fingerprint(
      p_user_id,
      p_idempotency_key,
      p_request_fingerprint,
      p_legacy_request_fingerprint,
      true
    );
begin
  return query
  select found.item_id,
         found.run_id,
         found.queue_message_id,
         found.photo_identity_kind,
         found.photo_identity_fingerprint,
         found.photo_receipts,
         handoff.receipt,
         found.is_replay
  from public.find_mobile_item_submission(
    p_user_id, p_idempotency_key, v_request_fingerprint
  ) found
  left join private.mobile_item_submission_voice_handoffs handoff
    on handoff.user_id = p_user_id
   and handoff.idempotency_key = p_idempotency_key
   and handoff.state = 'accepted';
end;
$$;

create or replace function public.find_mobile_item_submission_v2(
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text
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
  v_request_fingerprint text :=
    private.resolve_mobile_item_submission_v2_fingerprint(
      v_user_id,
      p_idempotency_key,
      p_request_fingerprint,
      p_legacy_request_fingerprint,
      true
    );
begin
  return query
  select found.item_id,
         found.run_id,
         found.queue_message_id,
         found.photo_identity_kind,
         found.photo_identity_fingerprint,
         found.photo_receipts,
         handoff.receipt,
         found.is_replay
  from public.find_mobile_item_submission(
    p_idempotency_key, v_request_fingerprint
  ) found
  left join private.mobile_item_submission_voice_handoffs handoff
    on handoff.user_id = v_user_id
   and handoff.idempotency_key = p_idempotency_key
   and handoff.state = 'accepted';
end;
$$;

create or replace function public.begin_mobile_item_submission_v2(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_photo_receipts jsonb,
  p_voice_receipt jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_fingerprint text :=
    private.resolve_mobile_item_submission_v2_fingerprint(
      p_user_id,
      p_idempotency_key,
      p_request_fingerprint,
      p_legacy_request_fingerprint,
      p_voice_receipt is null
    );
  v_created boolean;
begin
  v_created := public.begin_mobile_item_submission(
    p_user_id,
    p_idempotency_key,
    v_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_photo_receipts
  );
  perform private.bind_mobile_submission_voice_handoff(
    p_user_id,
    p_idempotency_key,
    v_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_voice_receipt
  );
  return v_created;
end;
$$;

create or replace function public.begin_mobile_item_submission_v2(
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_legacy_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_photo_receipts jsonb,
  p_voice_receipt jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
  v_request_fingerprint text :=
    private.resolve_mobile_item_submission_v2_fingerprint(
      v_user_id,
      p_idempotency_key,
      p_request_fingerprint,
      p_legacy_request_fingerprint,
      p_voice_receipt is null
    );
  v_created boolean;
begin
  v_created := public.begin_mobile_item_submission(
    p_idempotency_key,
    v_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_photo_receipts
  );
  perform private.bind_mobile_submission_voice_handoff(
    v_user_id,
    p_idempotency_key,
    v_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_voice_receipt
  );
  return v_created;
end;
$$;

create or replace function public.commit_mobile_item_submission_v2(
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
  p_voice_receipt jsonb
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
  v_request_fingerprint text :=
    private.resolve_mobile_item_submission_v2_fingerprint(
      p_user_id,
      p_idempotency_key,
      p_request_fingerprint,
      p_legacy_request_fingerprint,
      p_voice_receipt is null
    );
  v_committed record;
begin
  select committed.* into v_committed
  from public.commit_mobile_item_submission(
    p_user_id,
    p_idempotency_key,
    v_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_daily_limit,
    p_per_minute_limit,
    p_photo_identity,
    p_photo_receipts
  ) committed;

  voice_receipt := private.accept_mobile_submission_voice_handoff(
    p_user_id,
    p_idempotency_key,
    p_voice_receipt,
    v_committed.item_id,
    v_committed.run_id
  );
  item_id := v_committed.item_id;
  run_id := v_committed.run_id;
  queue_message_id := v_committed.queue_message_id;
  photo_identity_kind := v_committed.photo_identity_kind;
  photo_identity_fingerprint := v_committed.photo_identity_fingerprint;
  photo_receipts := v_committed.photo_receipts;
  is_replay := v_committed.is_replay;
  return next;
end;
$$;

create or replace function public.commit_mobile_item_submission_v2(
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
  p_voice_receipt jsonb
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
  v_request_fingerprint text :=
    private.resolve_mobile_item_submission_v2_fingerprint(
      v_user_id,
      p_idempotency_key,
      p_request_fingerprint,
      p_legacy_request_fingerprint,
      p_voice_receipt is null
    );
  v_committed record;
begin
  select committed.* into v_committed
  from public.commit_mobile_item_submission(
    p_idempotency_key,
    v_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_daily_limit,
    p_per_minute_limit,
    p_photo_identity,
    p_photo_receipts
  ) committed;

  if v_committed.denial_reason is null then
    voice_receipt := private.accept_mobile_submission_voice_handoff(
      v_user_id,
      p_idempotency_key,
      p_voice_receipt,
      v_committed.item_id,
      v_committed.run_id
    );
  else
    voice_receipt := null;
  end if;
  item_id := v_committed.item_id;
  run_id := v_committed.run_id;
  queue_message_id := v_committed.queue_message_id;
  photo_identity_kind := v_committed.photo_identity_kind;
  photo_identity_fingerprint := v_committed.photo_identity_fingerprint;
  photo_receipts := v_committed.photo_receipts;
  is_replay := v_committed.is_replay;
  denial_reason := v_committed.denial_reason;
  return next;
end;
$$;

revoke all on function public.find_mobile_item_submission_v2(
  text, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.find_mobile_item_submission_v2(
  text, uuid, text, text
) to service_role;

revoke all on function public.find_mobile_item_submission_v2(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.find_mobile_item_submission_v2(
  uuid, text, text
) to authenticated;

revoke all on function public.begin_mobile_item_submission_v2(
  text, uuid, text, text, uuid, uuid, numeric, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.begin_mobile_item_submission_v2(
  text, uuid, text, text, uuid, uuid, numeric, jsonb, jsonb
) to service_role;

revoke all on function public.begin_mobile_item_submission_v2(
  uuid, text, text, uuid, uuid, numeric, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.begin_mobile_item_submission_v2(
  uuid, text, text, uuid, uuid, numeric, jsonb, jsonb
) to authenticated;

revoke all on function public.commit_mobile_item_submission_v2(
  text, uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_mobile_item_submission_v2(
  text, uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb
) to service_role;

revoke all on function public.commit_mobile_item_submission_v2(
  uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_mobile_item_submission_v2(
  uuid, text, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb, jsonb
) to authenticated;

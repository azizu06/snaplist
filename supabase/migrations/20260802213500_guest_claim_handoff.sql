-- Issue #610: one-use App Attest guest-recovery handoffs.
-- Raw handoff and recovery tokens never enter Postgres; only SHA-256 digests do.

create table private.guest_claim_handoffs (
  handoff_id uuid primary key,
  token_digest bytea not null unique
    check (octet_length(token_digest) = 32),
  key_id text not null
    references private.app_attest_keys(key_id) on delete cascade,
  app_id text not null check (nullif(btrim(app_id), '') is not null),
  environment text not null
    check (environment in ('development', 'production')),
  guest_user_id text not null
    check (guest_user_id ~ '^guest_[0-9a-f]{48}$'),
  recovery_id uuid not null
    references private.guest_draft_recoveries(id) on delete cascade,
  recovery_token_hash text not null
    check (recovery_token_hash ~ '^[0-9a-f]{64}$'),
  photo_identity_kind text not null
    check (photo_identity_kind = 'content_sha256_set_v1'),
  photo_set_fingerprint text not null
    check (photo_set_fingerprint ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  check (
    expires_at > issued_at
    and expires_at <= issued_at + interval '10 minutes'
  )
);

create index guest_claim_handoffs_expiry_idx
  on private.guest_claim_handoffs (expires_at, handoff_id);

alter table private.guest_claim_handoffs enable row level security;

revoke all on table private.guest_claim_handoffs
  from public, anon, authenticated, service_role;

create or replace function public.issue_guest_claim_handoff(
  p_handoff_id uuid,
  p_token_digest bytea,
  p_key_id text,
  p_app_id text,
  p_environment text,
  p_guest_user_id text,
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_photo_set_fingerprint text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
    or p_handoff_id is null
    or p_token_digest is null
    or octet_length(p_token_digest) <> 32
    or nullif(btrim(p_key_id), '') is null
    or nullif(btrim(p_app_id), '') is null
    or p_environment not in ('development', 'production')
    or p_guest_user_id !~ '^guest_[0-9a-f]{48}$'
    or p_guest_user_id <> 'guest_' || pg_catalog.substr(
      pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(p_app_id, 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.convert_to(p_key_id, 'UTF8'),
          'sha256'
        ),
        'hex'
      ),
      1,
      48
    )
    or p_recovery_id is null
    or p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    or p_photo_set_fingerprint !~ '^[0-9a-f]{64}$'
    or p_issued_at is null
    or p_issued_at not between
      statement_timestamp() - interval '60 seconds'
      and statement_timestamp() + interval '60 seconds'
    or p_expires_at is null
    or p_expires_at <= p_issued_at
    or p_expires_at > p_issued_at + interval '10 minutes'
  then
    raise exception using
      errcode = '42501',
      message = 'Guest claim handoff issuance is not authorized';
  end if;

  insert into private.guest_claim_handoffs (
    handoff_id,
    token_digest,
    key_id,
    app_id,
    environment,
    guest_user_id,
    recovery_id,
    recovery_token_hash,
    photo_identity_kind,
    photo_set_fingerprint,
    issued_at,
    expires_at
  )
  select
    p_handoff_id,
    p_token_digest,
    p_key_id,
    p_app_id,
    p_environment,
    p_guest_user_id,
    p_recovery_id,
    p_recovery_token_hash,
    'content_sha256_set_v1',
    p_photo_set_fingerprint,
    p_issued_at,
    p_expires_at
  where exists (
    select 1
    from private.app_attest_keys key
    where key.key_id = p_key_id
      and key.app_id = p_app_id
      and key.environment = p_environment
  )
  and exists (
    select 1
    from private.guest_draft_recoveries recovery
    join public.items item
      on item.id = recovery.item_id
     and item.user_id = recovery.guest_user_id
    where recovery.id = p_recovery_id
      and recovery.guest_user_id = p_guest_user_id
      and recovery.recovery_token_hash = p_recovery_token_hash
      and recovery.state = 'claimable'
      and recovery.expires_at > statement_timestamp()
      and item.photo_identity_kind = 'content_sha256_set_v1'
      and item.photo_identity_fingerprint = p_photo_set_fingerprint
  )
  on conflict do nothing;

  return found;
end;
$$;

create or replace function public.consume_guest_claim_handoff(
  p_handoff_id uuid,
  p_token_digest bytea,
  p_app_id text,
  p_environment text
)
returns table (
  recovery_id uuid,
  guest_user_id text,
  recovery_token_hash text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
    or p_handoff_id is null
    or p_token_digest is null
    or octet_length(p_token_digest) <> 32
    or nullif(btrim(p_app_id), '') is null
    or p_environment not in ('development', 'production')
  then
    raise exception using
      errcode = '42501',
      message = 'Guest claim handoff verification is not authorized';
  end if;

  return query
  delete from private.guest_claim_handoffs handoff
  using private.app_attest_keys key,
        private.guest_draft_recoveries recovery,
        public.items item
  where handoff.handoff_id = p_handoff_id
    and handoff.token_digest = p_token_digest
    and handoff.app_id = p_app_id
    and handoff.environment = p_environment
    and handoff.expires_at > statement_timestamp()
    and key.key_id = handoff.key_id
    and key.app_id = handoff.app_id
    and key.environment = handoff.environment
    and recovery.id = handoff.recovery_id
    and recovery.guest_user_id = handoff.guest_user_id
    and recovery.recovery_token_hash = handoff.recovery_token_hash
    and recovery.state = 'claimable'
    and recovery.expires_at > statement_timestamp()
    and item.id = recovery.item_id
    and item.user_id = recovery.guest_user_id
    and item.photo_identity_kind = handoff.photo_identity_kind
    and item.photo_identity_fingerprint = handoff.photo_set_fingerprint
  returning
    handoff.recovery_id,
    handoff.guest_user_id,
    handoff.recovery_token_hash;
end;
$$;

revoke all on function public.issue_guest_claim_handoff(
  uuid, bytea, text, text, text, text, uuid, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.consume_guest_claim_handoff(
  uuid, bytea, text, text
) from public, anon, authenticated;

grant execute on function public.issue_guest_claim_handoff(
  uuid, bytea, text, text, text, text, uuid, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.consume_guest_claim_handoff(
  uuid, bytea, text, text
) to service_role;

create or replace function private.cleanup_guest_claim_handoff_retention()
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snaplist:guest-claim-handoff-retention', 0)
  );

  delete from private.guest_claim_handoffs
  where expires_at <= statement_timestamp();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.cleanup_guest_claim_handoff_retention()
  from public, anon, authenticated, service_role;

select cron.schedule(
  'snaplist-guest-claim-handoff-retention-hourly',
  '23 * * * *',
  'select private.cleanup_guest_claim_handoff_retention();'
);

create view private.guest_claim_handoff_retention_health
with (security_invoker = true)
as
select
  job.jobid,
  job.schedule,
  job.command,
  job.active,
  run.last_succeeded_at,
  expired.expired_rows,
  (
    job.jobid is null
    or job.schedule is distinct from '23 * * * *'
    or job.command is distinct from
      'select private.cleanup_guest_claim_handoff_retention();'
    or job.active is distinct from true
    or run.last_succeeded_at is null
    or run.last_succeeded_at
      < statement_timestamp() - interval '1 hour'
    or expired.expired_rows > 0
  ) as retention_breach
from (values (true)) singleton(present)
left join cron.job job
  on job.jobname = 'snaplist-guest-claim-handoff-retention-hourly'
left join lateral (
  select max(coalesce(history.end_time, history.start_time)) as last_succeeded_at
  from cron.job_run_details history
  where history.jobid = job.jobid
    and history.status = 'succeeded'
) run on true
cross join lateral (
  select count(*)::bigint as expired_rows
  from private.guest_claim_handoffs handoff
  where handoff.expires_at <= statement_timestamp()
) expired;

revoke all on private.guest_claim_handoff_retention_health
  from public, anon, authenticated, service_role;

-- Issue #331: private App Attest challenge, key, and replay truth only.
-- Forward-only addition after the current main migration history.
-- No guest principal, allowance, tenant-domain row, or public client authority.

create schema if not exists private;
create extension if not exists pg_cron;

create table private.app_attest_challenges (
  challenge_id uuid primary key,
  challenge bytea not null check (octet_length(challenge) >= 16),
  kind text not null check (kind in ('attestation', 'assertion')),
  key_id text,
  environment text not null check (environment in ('development', 'production')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  check (
    (kind = 'attestation' and key_id is null)
    or (kind = 'assertion' and nullif(btrim(key_id), '') is not null)
  ),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '10 minutes')
);

create table private.app_attest_keys (
  key_id text primary key check (nullif(btrim(key_id), '') is not null),
  app_id text not null check (nullif(btrim(app_id), '') is not null),
  environment text not null check (environment in ('development', 'production')),
  public_key_pem text not null check (public_key_pem like '-----BEGIN PUBLIC KEY-----%'),
  receipt bytea not null check (octet_length(receipt) > 0),
  assertion_counter bigint not null default 0 check (assertion_counter >= 0),
  bundle_version text not null check (nullif(btrim(bundle_version), '') is not null),
  validation_category integer not null check (validation_category between 1 and 6),
  attested_at timestamptz not null default statement_timestamp(),
  last_asserted_at timestamptz,
  check (last_asserted_at is null or last_asserted_at >= attested_at)
);

revoke all on table private.app_attest_challenges from public;
revoke all on table private.app_attest_keys from public;

create or replace function public.issue_app_attest_challenge(
  p_challenge_id uuid,
  p_challenge bytea,
  p_kind text,
  p_key_id text,
  p_environment text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_challenge_id is null
    or p_challenge is null
    or octet_length(p_challenge) < 16
    or p_kind not in ('attestation', 'assertion')
    or p_environment not in ('development', 'production')
    or p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + interval '10 minutes'
    or (p_kind = 'attestation' and p_key_id is not null)
    or (p_kind = 'assertion' and nullif(btrim(p_key_id), '') is null)
  then
    raise exception 'invalid_app_attest_challenge';
  end if;

  insert into private.app_attest_challenges (
    challenge_id,
    challenge,
    kind,
    key_id,
    environment,
    expires_at
  ) values (
    p_challenge_id,
    p_challenge,
    p_kind,
    p_key_id,
    p_environment,
    p_expires_at
  );
end;
$$;

create or replace function public.claim_app_attest_challenge(
  p_challenge_id uuid,
  p_kind text,
  p_key_id text,
  p_environment text
)
returns bytea
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge bytea;
begin
  update private.app_attest_challenges
  set consumed_at = statement_timestamp()
  where challenge_id = p_challenge_id
    and kind = p_kind
    and key_id is not distinct from p_key_id
    and environment = p_environment
    and consumed_at is null
    and expires_at > statement_timestamp()
  returning challenge into v_challenge;

  return v_challenge;
end;
$$;

create or replace function public.commit_app_attest_attestation(
  p_key_id text,
  p_app_id text,
  p_environment text,
  p_public_key_pem text,
  p_receipt bytea,
  p_bundle_version text,
  p_validation_category integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.app_attest_keys (
    key_id,
    app_id,
    environment,
    public_key_pem,
    receipt,
    bundle_version,
    validation_category
  ) values (
    p_key_id,
    p_app_id,
    p_environment,
    p_public_key_pem,
    p_receipt,
    p_bundle_version,
    p_validation_category
  )
  on conflict (key_id) do nothing;

  return found;
end;
$$;

create or replace function public.read_app_attest_key(p_key_id text)
returns table (
  key_id text,
  app_id text,
  environment text,
  public_key_pem text,
  receipt bytea,
  assertion_counter bigint,
  bundle_version text,
  validation_category integer,
  attested_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    key.key_id,
    key.app_id,
    key.environment,
    key.public_key_pem,
    key.receipt,
    key.assertion_counter,
    key.bundle_version,
    key.validation_category,
    key.attested_at
  from private.app_attest_keys key
  where key.key_id = p_key_id;
$$;

create or replace function public.commit_app_attest_assertion(
  p_key_id text,
  p_app_id text,
  p_environment text,
  p_assertion_counter bigint,
  p_bundle_version text,
  p_validation_category integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_committed boolean;
begin
  update private.app_attest_keys
  set
    assertion_counter = p_assertion_counter,
    bundle_version = p_bundle_version,
    validation_category = p_validation_category,
    last_asserted_at = statement_timestamp()
  where key_id = p_key_id
    and app_id = p_app_id
    and environment = p_environment
    and p_assertion_counter > assertion_counter
  returning true into v_committed;

  return coalesce(v_committed, false);
end;
$$;

create or replace function private.cleanup_app_attest_retention(
  p_now timestamptz,
  p_cleanup_challenges boolean,
  p_cleanup_keys boolean
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_deleted_challenges integer := 0;
  v_deleted_keys integer := 0;
begin
  if p_now is null
    or p_cleanup_challenges is null
    or p_cleanup_keys is null
  then
    raise exception 'invalid_app_attest_retention_cleanup';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snaplist:app-attest-retention', 0)
  );

  if p_cleanup_challenges then
    delete from private.app_attest_challenges
    where consumed_at is not null
      or expires_at <= p_now;
    get diagnostics v_deleted_challenges = row_count;
  end if;

  if p_cleanup_keys then
    delete from private.app_attest_keys
    where coalesce(last_asserted_at, attested_at)
      <= p_now - interval '90 days';
    get diagnostics v_deleted_keys = row_count;
  end if;

  return jsonb_build_object(
    'deletedChallenges', v_deleted_challenges,
    'deletedKeys', v_deleted_keys
  );
end;
$$;

create or replace function public.delete_app_attest_state_for_erasure(
  p_challenge_ids uuid[],
  p_key_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_challenges integer := 0;
  v_deleted_keys integer := 0;
begin
  if p_challenge_ids is null
    or p_key_ids is null
    or array_position(p_challenge_ids, null) is not null
    or array_position(p_key_ids, null) is not null
    or exists (
      select 1
      from unnest(p_key_ids) key_id
      where nullif(btrim(key_id), '') is null
    )
  then
    raise exception 'invalid_app_attest_erasure_scope';
  end if;

  delete from private.app_attest_challenges
  where challenge_id = any(p_challenge_ids)
    or key_id = any(p_key_ids);
  get diagnostics v_deleted_challenges = row_count;

  delete from private.app_attest_keys
  where key_id = any(p_key_ids);
  get diagnostics v_deleted_keys = row_count;

  return jsonb_build_object(
    'deletedChallenges', v_deleted_challenges,
    'deletedKeys', v_deleted_keys
  );
end;
$$;

revoke all on function public.issue_app_attest_challenge(uuid, bytea, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_app_attest_challenge(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.commit_app_attest_attestation(text, text, text, text, bytea, text, integer) from public, anon, authenticated;
revoke all on function public.read_app_attest_key(text) from public, anon, authenticated;
revoke all on function public.commit_app_attest_assertion(text, text, text, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.delete_app_attest_state_for_erasure(uuid[], text[]) from public, anon, authenticated;
revoke all on function private.cleanup_app_attest_retention(timestamptz, boolean, boolean) from public, anon, authenticated, service_role;

grant execute on function public.issue_app_attest_challenge(uuid, bytea, text, text, text, timestamptz) to service_role;
grant execute on function public.claim_app_attest_challenge(uuid, text, text, text) to service_role;
grant execute on function public.commit_app_attest_attestation(text, text, text, text, bytea, text, integer) to service_role;
grant execute on function public.read_app_attest_key(text) to service_role;
grant execute on function public.commit_app_attest_assertion(text, text, text, bigint, text, integer) to service_role;
grant execute on function public.delete_app_attest_state_for_erasure(uuid[], text[]) to service_role;

select cron.schedule(
  'snaplist-app-attest-retention-hourly',
  '17 * * * *',
  'select private.cleanup_app_attest_retention(statement_timestamp(), true, true);'
);

create view private.app_attest_retention_scheduler_health
with (security_invoker = true)
as
select
  job.jobid,
  job.schedule,
  job.command,
  job.active,
  run.last_succeeded_at,
  (
    job.jobid is null
    or job.schedule is distinct from '17 * * * *'
    or job.command is distinct from
      'select private.cleanup_app_attest_retention(statement_timestamp(), true, true);'
    or job.active is distinct from true
    or run.last_succeeded_at is null
    or run.last_succeeded_at
      < statement_timestamp() - interval '23 hours'
  ) as retention_breach
from (values (true)) singleton(present)
left join cron.job job
  on job.jobname = 'snaplist-app-attest-retention-hourly'
left join lateral (
  select max(coalesce(history.end_time, history.start_time)) as last_succeeded_at
  from cron.job_run_details history
  where history.jobid = job.jobid
    and history.status = 'succeeded'
) run on true;

revoke all on private.app_attest_retention_scheduler_health
from public, anon, authenticated, service_role;

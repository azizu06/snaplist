-- Issue #331: private App Attest challenge, key, and replay truth only.
-- Forward-only addition after the current main migration history.
-- No guest principal, allowance, tenant-domain row, or public client authority.

create schema if not exists private;

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
  last_asserted_at timestamptz
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

  if p_kind = 'assertion' and not exists (
    select 1
    from private.app_attest_keys key
    where key.key_id = p_key_id
      and key.environment = p_environment
  ) then
    raise exception 'unknown_app_attest_key';
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

revoke all on function public.issue_app_attest_challenge(uuid, bytea, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_app_attest_challenge(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.commit_app_attest_attestation(text, text, text, text, bytea, text, integer) from public, anon, authenticated;
revoke all on function public.read_app_attest_key(text) from public, anon, authenticated;
revoke all on function public.commit_app_attest_assertion(text, text, text, bigint, text, integer) from public, anon, authenticated;

grant execute on function public.issue_app_attest_challenge(uuid, bytea, text, text, text, timestamptz) to service_role;
grant execute on function public.claim_app_attest_challenge(uuid, text, text, text) to service_role;
grant execute on function public.commit_app_attest_attestation(text, text, text, text, bytea, text, integer) to service_role;
grant execute on function public.read_app_attest_key(text) to service_role;
grant execute on function public.commit_app_attest_assertion(text, text, text, bigint, text, integer) to service_role;

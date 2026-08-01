-- Issue #524: fence the included first AI offer by account AND physical device
-- before any spend-capable work begins.
--
-- Apple exposes DeviceCheck query and update but no compare-and-set, so the
-- narrow query-and-set window is serialized through one durable single-writer
-- redemption queue plus a global writer lease. That is an explicit
-- correctness-over-throughput choice (ADR context: issue #515).
--
-- The ephemeral DeviceCheck token is request material only. No column, queue
-- payload, or index in this migration stores it, hashes it, or derives an
-- identifier from it.

create extension if not exists pgmq;

do $$
begin
  if not exists (
    select 1
    from pgmq.meta
    where queue_name = 'included_offer_redemption'
  ) then
    perform pgmq.create('included_offer_redemption');
  end if;
end;
$$;

revoke all on schema pgmq from public, anon, authenticated, service_role;
revoke all on all tables in schema pgmq from public, anon, authenticated, service_role;
revoke all on all sequences in schema pgmq
  from public, anon, authenticated, service_role;
revoke execute on all functions in schema pgmq
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Durable account/device promotion claim
-- ---------------------------------------------------------------------------

create table public.included_offer_device_claims (
  claim_id uuid primary key,
  user_id text not null default public.clerk_user_id()
    check (user_id <> '' and char_length(user_id) <= 255),
  idempotency_key text not null
    check (idempotency_key <> '' and char_length(idempotency_key) <= 255),
  app_attest_key_id text not null
    check (app_attest_key_id <> '' and char_length(app_attest_key_id) <= 512),
  state text not null
    check (state in (
      'queued',
      'awaiting_device_token',
      'apple_pending',
      'reconcile_required',
      'reserved',
      'denied_device_consumed',
      'denied_apple_unavailable'
    )),
  -- Which Apple operation the claim was performing when an outcome went
  -- ambiguous. 'update' means a clear device was observed under the global
  -- writer lease, so a later set bit can only be this claim's own write.
  apple_phase text
    check (apple_phase is null or apple_phase in ('query', 'update')),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 100),
  queue_message_id bigint,
  token_deadline_at timestamptz,
  pipeline_run_id uuid references public.pipeline_runs (id) on delete set null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint included_offer_device_claims_idempotency_key
    unique (user_id, idempotency_key),
  constraint included_offer_device_claims_consumed_check check (
    consumed_at is null or state = 'reserved'
  )
);

comment on table public.included_offer_device_claims is
  'Issue #524: durable per-account claim on the included first AI offer, fenced by Apple DeviceCheck bit0. Never stores a DeviceCheck token.';
comment on column public.included_offer_device_claims.apple_phase is
  'query = never observed a clear device; update = observed clear under the writer lease. Decides how an ambiguous outcome reconciles.';
comment on column public.included_offer_device_claims.consumed_at is
  'Set when the reservation boundary spends this claim on a pipeline run.';

create index included_offer_device_claims_user_state_idx
  on public.included_offer_device_claims (user_id, state, created_at);
create index included_offer_device_claims_open_idx
  on public.included_offer_device_claims (state)
  where state not in (
    'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
  );

alter table public.included_offer_device_claims enable row level security;
revoke all on table public.included_offer_device_claims
  from public, anon, authenticated, service_role;
grant select on table public.included_offer_device_claims to authenticated;
-- No insert or update: every write goes through an audited security-definer RPC
-- below, so no key can forge or mutate a claim outside that seam. Delete stays
-- for the account-erasure capability the retention matrix names as executor.
grant select, delete on table public.included_offer_device_claims
  to service_role;

-- Tenants read their own promotion state and nothing else. Every write goes
-- through an audited security-definer RPC below.
create policy included_offer_device_claims_select_own
  on public.included_offer_device_claims
  for select to authenticated
  using (public.clerk_user_id() = user_id);

-- ---------------------------------------------------------------------------
-- Audited one-time support override
-- ---------------------------------------------------------------------------

create table public.included_offer_support_overrides (
  override_id uuid primary key,
  user_id text not null
    check (user_id <> '' and char_length(user_id) <= 255),
  claim_id uuid references public.included_offer_device_claims (claim_id)
    on delete set null,
  granted_by text not null
    check (granted_by <> '' and char_length(granted_by) <= 255),
  reason text not null check (char_length(reason) between 1 and 2000),
  granted_at timestamptz not null default now(),
  consumed_at timestamptz,
  constraint included_offer_support_overrides_consumed_order check (
    consumed_at is null or consumed_at >= granted_at
  )
);

comment on table public.included_offer_support_overrides is
  'Issue #524: audited one-time account/claim-scoped exception to the device fence. Never clears the lifetime Apple DeviceCheck bit.';

-- One live exception per account: an override is a fairness exception, not a
-- second promotion.
create unique index included_offer_support_overrides_one_active
  on public.included_offer_support_overrides (user_id)
  where consumed_at is null;

alter table public.included_offer_support_overrides enable row level security;
revoke all on table public.included_offer_support_overrides
  from public, anon, authenticated, service_role;
grant select on table public.included_offer_support_overrides to authenticated;
grant select, delete
  on table public.included_offer_support_overrides to service_role;

create policy included_offer_support_overrides_select_own
  on public.included_offer_support_overrides
  for select to authenticated
  using (public.clerk_user_id() = user_id);

-- ---------------------------------------------------------------------------
-- Global single-writer lease over Apple's query-and-set window
-- ---------------------------------------------------------------------------

create table private.included_offer_writer_lease (
  singleton boolean primary key default true check (singleton),
  claim_id uuid not null,
  leased_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > leased_at)
);

comment on table private.included_offer_writer_lease is
  'Issue #524: at most one claim anywhere may be mid-DeviceCheck-rendezvous. Apple has no compare-and-set, so this is the serialization point.';

alter table private.included_offer_writer_lease enable row level security;
revoke all on table private.included_offer_writer_lease
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Claim state machine
-- ---------------------------------------------------------------------------

create or replace function private.enforce_included_offer_claim_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.claim_id is distinct from old.claim_id
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'Included-offer claim identity is immutable';
  end if;

  if new.state is distinct from old.state then
    if old.state in (
      'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
    ) then
      raise exception using
        errcode = '23514',
        message = 'Included-offer claim is already terminal';
    end if;
    if not (
      (old.state = 'queued' and new.state in (
        'awaiting_device_token', 'reserved', 'denied_apple_unavailable'
      ))
      or (old.state = 'awaiting_device_token' and new.state in (
        'queued', 'apple_pending', 'reserved',
        'denied_device_consumed', 'denied_apple_unavailable'
      ))
      -- apple_pending -> awaiting_device_token is the crash-recovery path: a
      -- redelivered claim may need a fresh ephemeral token to finish.
      or (old.state = 'apple_pending' and new.state in (
        'awaiting_device_token', 'reconcile_required', 'reserved',
        'denied_device_consumed', 'denied_apple_unavailable'
      ))
      or (old.state = 'reconcile_required' and new.state in (
        'awaiting_device_token', 'apple_pending',
        'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
      ))
    ) then
      raise exception using
        errcode = '23514',
        message = format(
          'Unsupported included-offer claim transition %s -> %s',
          old.state, new.state
        );
    end if;
  end if;

  -- Observing a clear device is a one-way step. Downgrading it would let an
  -- ambiguous update reconcile as somebody else's consumption.
  if old.apple_phase = 'update' and new.apple_phase is distinct from 'update' then
    raise exception using
      errcode = '23514',
      message = 'Included-offer clear-device observation cannot be withdrawn';
  end if;

  if old.consumed_at is not null
    and new.consumed_at is distinct from old.consumed_at then
    raise exception using
      errcode = '23514',
      message = 'Included-offer claim is already spent';
  end if;

  new.updated_at := statement_timestamp();
  return new;
end;
$$;

revoke all on function private.enforce_included_offer_claim_transition()
  from public, anon, authenticated, service_role;

create trigger included_offer_device_claims_enforce_transition
  before update on public.included_offer_device_claims
  for each row execute function private.enforce_included_offer_claim_transition();

-- ---------------------------------------------------------------------------
-- Claim authority RPCs (service_role only)
-- ---------------------------------------------------------------------------

create or replace function private.included_offer_claim_json(
  p_claim public.included_offer_device_claims
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'claim_id', p_claim.claim_id,
    'user_id', p_claim.user_id,
    'idempotency_key', p_claim.idempotency_key,
    'app_attest_key_id', p_claim.app_attest_key_id,
    'state', p_claim.state,
    'apple_phase', p_claim.apple_phase,
    'attempt_count', p_claim.attempt_count,
    'queue_message_id', p_claim.queue_message_id,
    'token_deadline_at', p_claim.token_deadline_at,
    'consumed_at', p_claim.consumed_at,
    'created_at', p_claim.created_at,
    'updated_at', p_claim.updated_at
  );
$$;

revoke all on function private.included_offer_claim_json(
  public.included_offer_device_claims
) from public, anon, authenticated, service_role;

create or replace function private.assert_included_offer_authority()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Included-offer redemption authorization is required';
  end if;
end;
$$;

revoke all on function private.assert_included_offer_authority()
  from public, anon, authenticated, service_role;

create or replace function public.begin_included_offer_claim(
  p_claim_id uuid,
  p_user_id text,
  p_idempotency_key text,
  p_app_attest_key_id text,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.included_offer_device_claims%rowtype;
begin
  perform private.assert_included_offer_authority();
  if p_claim_id is null
    or coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or coalesce(p_idempotency_key, '') = ''
    or char_length(p_idempotency_key) > 255
    or coalesce(p_app_attest_key_id, '') = ''
    or p_state not in ('queued', 'reserved') then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer claim';
  end if;

  insert into public.included_offer_device_claims (
    claim_id, user_id, idempotency_key, app_attest_key_id, state
  ) values (
    p_claim_id, p_user_id, p_idempotency_key, p_app_attest_key_id, p_state
  )
  on conflict (user_id, idempotency_key) do nothing;

  select * into v_claim
  from public.included_offer_device_claims claim
  where claim.user_id = p_user_id
    and claim.idempotency_key = p_idempotency_key;
  return private.included_offer_claim_json(v_claim);
end;
$$;

revoke all on function public.begin_included_offer_claim(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.begin_included_offer_claim(uuid, text, text, text, text) to service_role;

create or replace function public.find_included_offer_claim(
  p_claim_id uuid,
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.included_offer_device_claims%rowtype;
begin
  perform private.assert_included_offer_authority();

  -- The worker derives authority from the stored claim, never from a caller
  -- assertion: a null p_user_id is the run-scoped worker read, and any
  -- non-null value must match the claim's owner exactly.
  select * into v_claim
  from public.included_offer_device_claims claim
  where claim.claim_id = p_claim_id
    and (p_user_id is null or claim.user_id = p_user_id);
  if not found then
    return null;
  end if;
  return private.included_offer_claim_json(v_claim);
end;
$$;

revoke all on function public.find_included_offer_claim(uuid, text)
  from public, anon, authenticated;
grant execute on function public.find_included_offer_claim(uuid, text)
  to service_role;

create or replace function public.find_included_offer_claim_by_key(
  p_user_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.included_offer_device_claims%rowtype;
begin
  perform private.assert_included_offer_authority();
  select * into v_claim
  from public.included_offer_device_claims claim
  where claim.user_id = p_user_id
    and claim.idempotency_key = p_idempotency_key;
  if not found then
    return null;
  end if;
  return private.included_offer_claim_json(v_claim);
end;
$$;

revoke all on function public.find_included_offer_claim_by_key(text, text)
  from public, anon, authenticated;
grant execute on function public.find_included_offer_claim_by_key(text, text)
  to service_role;

create or replace function public.transition_included_offer_claim(
  p_claim_id uuid,
  p_from text[],
  p_to text,
  p_apple_phase text default null,
  p_set_apple_phase boolean default false,
  p_attempt_count integer default null,
  p_token_deadline_at timestamptz default null,
  p_set_token_deadline boolean default false,
  p_require_writer_lease boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.included_offer_device_claims%rowtype;
begin
  perform private.assert_included_offer_authority();
  if p_claim_id is null or p_from is null or array_length(p_from, 1) is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer claim transition';
  end if;

  update public.included_offer_device_claims claim
  set state = p_to,
      apple_phase = case
        when p_set_apple_phase then p_apple_phase else claim.apple_phase
      end,
      attempt_count = coalesce(p_attempt_count, claim.attempt_count),
      token_deadline_at = case
        when p_set_token_deadline then p_token_deadline_at
        else claim.token_deadline_at
      end
  where claim.claim_id = p_claim_id
    and claim.state = any (p_from)
    -- Claiming the clear-device observation and proving the lease is still held
    -- have to be one statement. Checking first and writing second leaves a gap
    -- in which the lease lapses, a rival takes it, spends the device, and this
    -- write lands anyway on a reading that is no longer true.
    and (
      not p_require_writer_lease
      or exists (
        select 1
        from private.included_offer_writer_lease lease
        where lease.claim_id = p_claim_id
          and lease.expires_at > statement_timestamp()
      )
    )
  returning * into v_claim;
  if not found then
    return null;
  end if;
  return private.included_offer_claim_json(v_claim);
end;
$$;

revoke all on function public.transition_included_offer_claim(
  uuid, text[], text, text, boolean, integer, timestamptz, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.transition_included_offer_claim(
  uuid, text[], text, text, boolean, integer, timestamptz, boolean, boolean
) to service_role;

-- ---------------------------------------------------------------------------
-- Tokenless single-writer redemption queue
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_included_offer_claim(
  p_claim_id uuid,
  p_schema_version smallint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.included_offer_device_claims%rowtype;
  v_message_id bigint;
begin
  perform private.assert_included_offer_authority();
  if p_schema_version <> 1 then
    raise exception using
      errcode = '22023',
      message = 'Unsupported included-offer queue schema version';
  end if;

  select * into v_claim
  from public.included_offer_device_claims claim
  where claim.claim_id = p_claim_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Included-offer claim not found';
  end if;
  if v_claim.state <> 'queued' then
    raise exception using
      errcode = '55000',
      message = 'Only queued included-offer claims can be enqueued';
  end if;
  if v_claim.queue_message_id is not null then
    return v_claim.queue_message_id;
  end if;

  -- The envelope carries claim identity only: no DeviceCheck token, no user id,
  -- no App Attest evidence.
  select *
  into v_message_id
  from pgmq.send(
    'included_offer_redemption',
    jsonb_build_object('claim_id', p_claim_id, 'schema_version', p_schema_version)
  );

  update public.included_offer_device_claims
  set queue_message_id = v_message_id
  where claim_id = p_claim_id;
  return v_message_id;
end;
$$;

revoke all on function public.enqueue_included_offer_claim(uuid, smallint)
  from public, anon, authenticated;
grant execute on function public.enqueue_included_offer_claim(uuid, smallint)
  to service_role;

create or replace function public.claim_included_offer_message(
  p_visibility_timeout_seconds integer
)
returns table (
  message_id bigint,
  read_count bigint,
  envelope jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_included_offer_authority();
  if p_visibility_timeout_seconds not between 1 and 3600 then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer queue claim bounds';
  end if;

  -- Quantity is fixed at one. This queue exists to serialize, not to batch.
  return query
  select message.msg_id, message.read_ct::bigint, message.message
  from pgmq.read('included_offer_redemption', p_visibility_timeout_seconds, 1)
    message;
end;
$$;

revoke all on function public.claim_included_offer_message(integer)
  from public, anon, authenticated;
grant execute on function public.claim_included_offer_message(integer)
  to service_role;

create or replace function public.ack_included_offer_message(p_message_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  perform private.assert_included_offer_authority();
  if p_message_id <= 0 then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer queue message id';
  end if;
  select pgmq.delete('included_offer_redemption', p_message_id) into v_deleted;
  return v_deleted;
end;
$$;

revoke all on function public.ack_included_offer_message(bigint)
  from public, anon, authenticated;
grant execute on function public.ack_included_offer_message(bigint) to service_role;

create or replace function public.defer_included_offer_message(
  p_message_id bigint,
  p_visibility_timeout_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message_id bigint;
begin
  perform private.assert_included_offer_authority();
  if p_message_id <= 0
    or p_visibility_timeout_seconds not between 0 and 3600 then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer queue defer bounds';
  end if;
  select msg_id
  into v_message_id
  from pgmq.set_vt(
    'included_offer_redemption', p_message_id, p_visibility_timeout_seconds
  );
  return v_message_id is not null;
end;
$$;

revoke all on function public.defer_included_offer_message(bigint, integer)
  from public, anon, authenticated;
grant execute on function public.defer_included_offer_message(bigint, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Writer lease
-- ---------------------------------------------------------------------------

create or replace function public.acquire_included_offer_writer_lease(
  p_claim_id uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_acquired integer;
begin
  perform private.assert_included_offer_authority();
  if p_claim_id is null or p_lease_seconds not between 1 and 600 then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer writer lease bounds';
  end if;

  -- An unresolved write outranks an expired lease. A non-terminal claim at
  -- phase 'update' observed a clear device and may or may not have landed its
  -- write, so the device bit is indeterminate but already spoken for. Letting a
  -- rival read that bit as clear is exactly how one device mints two included
  -- runs, and no lease timeout makes it somebody else's to claim.
  if exists (
    select 1
    from public.included_offer_device_claims claim
    where claim.apple_phase = 'update'
      and claim.claim_id <> p_claim_id
      and claim.state not in (
        'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
      )
  ) then
    return false;
  end if;

  insert into private.included_offer_writer_lease (
    singleton, claim_id, leased_at, expires_at
  ) values (
    true, p_claim_id, v_now, v_now + make_interval(secs => p_lease_seconds)
  )
  on conflict (singleton) do update
  set claim_id = excluded.claim_id,
      leased_at = excluded.leased_at,
      expires_at = excluded.expires_at
  where private.included_offer_writer_lease.expires_at <= v_now
     or private.included_offer_writer_lease.claim_id = p_claim_id;

  get diagnostics v_acquired = row_count;
  return v_acquired > 0;
end;
$$;

revoke all on function public.acquire_included_offer_writer_lease(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_included_offer_writer_lease(uuid, integer)
  to service_role;

create or replace function public.release_included_offer_writer_lease(
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  perform private.assert_included_offer_authority();
  delete from private.included_offer_writer_lease lease
  where lease.claim_id = p_claim_id;
  get diagnostics v_released = row_count;
  return v_released > 0;
end;
$$;

revoke all on function public.release_included_offer_writer_lease(uuid)
  from public, anon, authenticated;
grant execute on function public.release_included_offer_writer_lease(uuid)
  to service_role;

-- Single-writer means one open rendezvous, not one message in flight. The
-- worker asks this before inviting the next claim, so a second account is never
-- told to mint a fresh ephemeral token it can only be refused for.
--
-- Occupancy means either the claim's token window is still open, or it carries
-- an unresolved 'update' write that no other claim can make progress past
-- anyway. A claim past its deadline that never observed clear stops blocking.
--
-- Returns a boolean rather than the claim: the worker does not own the blocking
-- claim and has no business reading another tenant's identity out of it.
create or replace function public.has_open_included_offer_rendezvous(
  p_except_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
begin
  perform private.assert_included_offer_authority();
  -- Without this, a null argument makes the comparison below null, `exists`
  -- false, and the rendezvous read as free — the one answer that lets a second
  -- account be invited onto a device somebody else is mid-write on.
  if p_except_claim_id is null then
    raise exception using
      errcode = '22023',
      message = 'Included-offer rendezvous occupancy needs a claim to exclude';
  end if;
  return exists (
    select 1
    from public.included_offer_device_claims claim
    where claim.state in (
        'awaiting_device_token', 'apple_pending', 'reconcile_required'
      )
      and claim.claim_id <> p_except_claim_id
      and (
        (claim.token_deadline_at is not null and claim.token_deadline_at > v_now)
        or claim.apple_phase = 'update'
      )
  );
end;
$$;

revoke all on function public.has_open_included_offer_rendezvous(uuid)
  from public, anon, authenticated;
grant execute on function public.has_open_included_offer_rendezvous(uuid)
  to service_role;

-- Releases a rendezvous whose unresolved write has gone stale.
--
-- Terminalizing is the only safe release. The device bit may or may not have
-- been set, so the abandoning claim must lose the offer before any other claim
-- may read that bit: set means denied, clear means genuinely unspent. Merely
-- unblocking would let both claims reserve.
create or replace function public.expire_stale_included_offer_rendezvous(
  p_older_than timestamptz
)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_included_offer_authority();
  if p_older_than is null then
    raise exception using
      errcode = '22023',
      message = 'Included-offer rendezvous expiry needs a cutoff';
  end if;
  return query
  update public.included_offer_device_claims claim
  set state = 'denied_apple_unavailable',
      token_deadline_at = null
  where claim.apple_phase = 'update'
    and claim.state not in (
      'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
    )
    and claim.updated_at <= p_older_than
  returning claim.claim_id;
end;
$$;

revoke all on function public.expire_stale_included_offer_rendezvous(timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_stale_included_offer_rendezvous(timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- Audited support override
-- ---------------------------------------------------------------------------

create or replace function public.grant_included_offer_support_override(
  p_override_id uuid,
  p_user_id text,
  p_granted_by text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_override public.included_offer_support_overrides%rowtype;
begin
  perform private.assert_included_offer_authority();
  if p_override_id is null
    or coalesce(p_user_id, '') = ''
    or coalesce(p_granted_by, '') = ''
    or coalesce(p_reason, '') = ''
    or char_length(p_reason) > 2000 then
    raise exception using
      errcode = '22023',
      message = 'Invalid included-offer support override';
  end if;

  insert into public.included_offer_support_overrides (
    override_id, user_id, granted_by, reason
  ) values (p_override_id, p_user_id, p_granted_by, p_reason)
  returning * into v_override;

  return jsonb_build_object(
    'override_id', v_override.override_id,
    'user_id', v_override.user_id,
    'claim_id', v_override.claim_id,
    'granted_by', v_override.granted_by,
    'reason', v_override.reason,
    'granted_at', v_override.granted_at,
    'consumed_at', v_override.consumed_at
  );
end;
$$;

revoke all on function public.grant_included_offer_support_override(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.grant_included_offer_support_override(
  uuid, text, text, text
) to service_role;

create or replace function public.find_active_included_offer_override(
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_override public.included_offer_support_overrides%rowtype;
begin
  perform private.assert_included_offer_authority();
  select * into v_override
  from public.included_offer_support_overrides override
  where override.user_id = p_user_id
    and override.consumed_at is null
  limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'override_id', v_override.override_id,
    'user_id', v_override.user_id,
    'claim_id', v_override.claim_id,
    'granted_by', v_override.granted_by,
    'reason', v_override.reason,
    'granted_at', v_override.granted_at,
    'consumed_at', v_override.consumed_at
  );
end;
$$;

revoke all on function public.find_active_included_offer_override(text)
  from public, anon, authenticated;
grant execute on function public.find_active_included_offer_override(text)
  to service_role;

create or replace function public.consume_included_offer_override(
  p_override_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consumed integer;
begin
  perform private.assert_included_offer_authority();
  update public.included_offer_support_overrides override
  set consumed_at = statement_timestamp(),
      claim_id = p_claim_id
  where override.override_id = p_override_id
    and override.consumed_at is null
    and exists (
      select 1
      from public.included_offer_device_claims claim
      where claim.claim_id = p_claim_id
        and claim.user_id = override.user_id
    );
  get diagnostics v_consumed = row_count;
  return v_consumed > 0;
end;
$$;

revoke all on function public.consume_included_offer_override(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.consume_included_offer_override(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Compose with the pre-spend AI-item credit reservation boundary
-- ---------------------------------------------------------------------------
--
-- This is the only place a Clerk account can begin spending the included first
-- AI run, so it is the only place the device fence can be closed atomically.
-- Raising here aborts the pipeline_runs insert, so no run row, no queue
-- message, and no provider work can follow.

create or replace function private.reserve_ai_item_credit_for_pipeline_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_paths text[];
  v_photo_set_fingerprint text;
  v_period public.ai_item_allowance_periods%rowtype;
  v_used integer;
  v_existing public.ai_item_credit_reservations%rowtype;
  v_claim public.included_offer_device_claims%rowtype;
  v_uses_included boolean := false;
  v_now timestamptz := statement_timestamp();
begin
  if new.capture_input is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || new.user_id, 0)
  );

  select item.photos into v_photo_paths
  from public.items item
  where item.id = new.item_id
    and item.user_id = new.user_id
  for update;
  if not found or cardinality(v_photo_paths) not between 1 and 5 then
    raise exception using
      errcode = '23503',
      message = 'AI-item credit run has no owned immutable photo set';
  end if;
  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(v_photo_paths)::text, 'UTF8')),
    'hex'
  );

  insert into public.ai_item_allowance_periods (
    user_id,
    source,
    period_key,
    period_start,
    expires_date,
    state,
    allowance
  ) values (
    new.user_id,
    'included',
    'included-first-run',
    '-infinity'::timestamptz,
    'infinity'::timestamptz,
    'active',
    1
  )
  on conflict (user_id, source, period_key) do nothing;

  select * into v_period
  from public.ai_item_allowance_periods period
  where period.user_id = new.user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;

  select count(*) into v_used
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_period.id
    and (
      reservation.state in ('reserved', 'settled')
      or (
        reservation.state = 'restored'
        and reservation.retry_reservation_count > reservation.retry_restore_count
      )
    );

  if v_used >= v_period.allowance then
    select * into v_period
    from public.ai_item_allowance_periods period
    where period.user_id = new.user_id
      and period.source = 'storekit'
      and period.period_start <= v_now
    order by period.period_start desc, period.expires_date desc
    limit 1
    for update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: snaplist-pro-required';
    end if;
    if not (
      (v_period.state = 'active' and v_now < v_period.expires_date)
      or (
        v_period.state = 'grace'
        and v_period.grace_expires_date is not null
        and v_now < v_period.grace_expires_date
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: storekit-entitlement-unavailable';
    end if;

    select count(*) into v_used
    from public.ai_item_credit_reservations reservation
    where reservation.allowance_period_id = v_period.id
      and (
        reservation.state in ('reserved', 'settled')
        or (
          reservation.state = 'restored'
          and reservation.retry_reservation_count > reservation.retry_restore_count
        )
      );
    if v_used >= v_period.allowance then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: monthly-allowance-reached';
    end if;
  else
    v_uses_included := true;
  end if;

  -- Issue #524: the included promotion additionally requires that this physical
  -- Apple device has not already consumed it. #332 verified-guest principals are
  -- fenced by their own App Attest-backed allowance and are out of scope here.
  if v_uses_included
    and new.user_id !~ '^guest_[0-9a-f]{48}$'
    and not exists (
      -- A technical retry after a restored credit reuses the account's already
      -- spent claim; the device is not asked to pay twice for one account.
      select 1
      from public.included_offer_device_claims spent
      where spent.user_id = new.user_id
        and spent.consumed_at is not null
    )
  then
    select * into v_claim
    from public.included_offer_device_claims claim
    where claim.user_id = new.user_id
      and claim.state = 'reserved'
      and claim.consumed_at is null
    order by claim.created_at
    limit 1
    for update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: device-fence-required';
    end if;

    update public.included_offer_device_claims
    set consumed_at = v_now,
        pipeline_run_id = new.id
    where claim_id = v_claim.claim_id;
  end if;

  insert into public.ai_item_credit_reservations (
    user_id,
    pipeline_run_id,
    item_id,
    allowance_period_id,
    logical_run_key,
    photo_set_fingerprint
  ) values (
    new.user_id,
    new.id,
    new.item_id,
    v_period.id,
    new.idempotency_key,
    v_photo_set_fingerprint
  )
  on conflict (pipeline_run_id) do nothing;

  select * into v_existing
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = new.id;
  if not found
    or v_existing.user_id is distinct from new.user_id
    or v_existing.item_id is distinct from new.item_id
    or v_existing.logical_run_key is distinct from new.idempotency_key
    or v_existing.photo_set_fingerprint is distinct from v_photo_set_fingerprint then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit reservation identity conflicts';
  end if;
  return new;
end;
$$;

revoke all on function private.reserve_ai_item_credit_for_pipeline_run()
  from public, anon, authenticated, service_role;

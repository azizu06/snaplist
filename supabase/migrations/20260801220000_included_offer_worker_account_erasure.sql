-- Issue #588: keep the included-offer worker advancing while one tenant is
-- being erased.
--
-- #587 (migration 20260801200000) put `zzz_fence_account_erasure_tenant_mutation`
-- on `public.included_offer_device_claims`. That is correct and #586 required
-- it. What neither issue covered is that both of the redemption worker's write
-- paths are UPDATEs on that table, so both began raising as soon as any tenant
-- mid-erasure held a non-terminal claim:
--
--   * `public.expire_stale_included_offer_rendezvous` is a deployment-wide sweep
--     with no user predicate and runs first on every tick.
--   * `public.transition_included_offer_claim` raises when the erasing tenant's
--     own claim reaches the queue head.
--
-- Either raise aborts the tick and the cron route 500s, so one account's
-- deletion stops redemption for every other account until the erasure finishes.
--
-- The escape here is a skip, not a bypass. Nothing in this migration lets the
-- worker write a fenced row: `private.assert_account_erasure_mutation_allowed`
-- is untouched in behaviour, and an ordinary write to an erasing tenant's claim
-- still raises. The worker simply stops selecting rows the fence would refuse.
--
-- Skipping the sweep is not sufficient on its own, and stopping there would
-- have replaced a 500 with a silent stall of exactly the same length. A
-- non-terminal claim carrying `apple_phase = 'update'` occupies the
-- deployment-wide rendezvous, and the sweep is the only thing that releases it.
-- Skip the sweep and leave the occupancy readers alone, and every other account
-- is refused the writer lease until `advance_account_erasure` gets around to
-- deleting the row — which it may defer across many ticks on storage, eBay,
-- guest and mixed-tenant conditions. So the two readers that gate the next
-- account have to agree with the sweep: a row the sweep can no longer reach no
-- longer holds the rendezvous.
--
-- That release is safe for one reason, and it is a proof rather than a
-- judgement call. Releasing an unresolved rendezvous is normally unsafe because
-- the abandoning claim could later come back and reserve on a device somebody
-- else has since read as clear — which is why the sweep terminalizes rather
-- than merely unblocking. An erasing owner's claim cannot come back:
--
--   1. The table grants no insert or update to any role. Every write goes
--      through a security-definer RPC in 20260731190000.
--   2. Every one of those RPCs fires the fence trigger, which raises while a
--      generation row exists for the owner.
--   3. The only way past the fence is `app.account_erasure_internal`, which is
--      set inside `advance_account_erasure` alone, and that function only
--      deletes these rows.
--   4. The generation row outlives the claim. It is removed only by
--      `prune_account_erasure_receipts`, 30 days after `completed_at`, and
--      completion requires `account_erasure_owned_row_count` to reach zero —
--      a count that includes this table.
--
-- So the claim is deleted before the fence can ever lift, and it can never
-- reserve. `supabase/tests/included_offer_worker_account_erasure.test.sql`
-- asserts step 2 directly rather than trusting this comment.

-- One predicate, one definition. The skip below has to describe exactly the set
-- the fence raises on: if the two ever drift, the worker selects a row the
-- fence refuses and the aborted tick comes straight back. Extracting it from
-- `assert_account_erasure_mutation_allowed` is what makes that impossible
-- rather than merely unlikely.
create function private.account_erasure_started(p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_user_id, '') <> '' and exists (
    select 1
    from private.account_erasure_generations generation
    where generation.user_id_digest = private.account_erasure_user_digest(p_user_id)
  )
$$;

comment on function private.account_erasure_started(text) is
  'True while a tenant has an account-erasure generation on file. The single '
  'definition shared by the mutation fence and by every worker path that must '
  'skip the rows the fence refuses.';

revoke all on function private.account_erasure_started(text)
  from public, anon, authenticated, service_role;

-- Behaviour is unchanged; the existence test now comes from the shared
-- predicate above instead of a second copy of it.
create or replace function private.assert_account_erasure_mutation_allowed(
  p_user_id text,
  p_allow_provider_completion boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(p_user_id, '') = '' then return; end if;
  if coalesce(auth.jwt()->>'role', '') = 'service_role'
    and current_setting('app.account_erasure_internal', true) = 'true' then
    return;
  end if;
  if p_allow_provider_completion then return; end if;
  if private.account_erasure_started(p_user_id) then
    raise exception using
      errcode = '55000',
      message = 'Account erasure has started for this account';
  end if;
end;
$$;

revoke all on function private.assert_account_erasure_mutation_allowed(text, boolean)
  from public, anon, authenticated, service_role;

-- The sweep. Unchanged from 20260731190000 except for the owner skip.
--
-- The skip lives in the statement's own predicate rather than in a pre-check, so
-- the sweep never selects a fenced row in the first place. A generation that
-- commits between this statement's snapshot and the trigger firing can still
-- raise; that window is one erasure beginning mid-statement, it is fail-closed,
-- and the next tick a minute later skips the row cleanly.
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
    -- Erasure deletes this row, which releases the rendezvous the same way
    -- terminalizing it would. Until then it is not this sweep's to write.
    and not private.account_erasure_started(claim.user_id)
  returning claim.claim_id;
end;
$$;

-- Occupancy. Unchanged from 20260731190000 except for the owner skip.
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
      -- A claim the sweep can no longer reach is one no tick will ever release,
      -- and one that can never reserve. Counting it as occupancy would hold the
      -- whole deployment behind an account that is on its way out.
      and not private.account_erasure_started(claim.user_id)
  );
end;
$$;

-- The single-writer lease. Unchanged from 20260731190000 except for the owner
-- skip on the unresolved-write guard, for the same reason.
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
  -- runs, and no lease timeout makes it somebody else's to claim. An erasing
  -- owner is the one exception, and only because that claim provably can never
  -- take the offer it is holding open.
  if exists (
    select 1
    from public.included_offer_device_claims claim
    where claim.apple_phase = 'update'
      and claim.claim_id <> p_claim_id
      and claim.state not in (
        'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
      )
      and not private.account_erasure_started(claim.user_id)
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

-- The head transition. Unchanged from 20260731190000 except for the owner skip
-- and the outcome it reports.
--
-- Returning null for an erasing owner would be indistinguishable from an
-- ordinary state-guard miss, and the worker would defer the head forever with
-- nothing recorded anywhere. The refusal is a value instead, so the tick can
-- report it. It is deliberately not a claim shape: every caller that expects a
-- claim parses strictly and will reject it rather than mistake it for one.
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
    and not private.account_erasure_started(claim.user_id)
  returning * into v_claim;
  if not found then
    -- Asked after the write rather than before it, so the statement above never
    -- reaches a fenced row and the answer still names the reason.
    if exists (
      select 1
      from public.included_offer_device_claims claim
      where claim.claim_id = p_claim_id
        and private.account_erasure_started(claim.user_id)
    ) then
      return jsonb_build_object('outcome', 'account_erasure_in_progress');
    end if;
    return null;
  end if;
  return private.included_offer_claim_json(v_claim);
end;
$$;

begin;

select plan(13);

-- Issue #588: one tenant being erased must not stop the included-offer worker
-- for everyone else.
--
-- #587 put `zzz_fence_account_erasure_tenant_mutation` on
-- `public.included_offer_device_claims`, which is correct. Both of the worker's
-- write paths are UPDATEs on that table, so both started raising the moment any
-- tenant mid-erasure held a non-terminal claim: the set-wide sweep on every
-- tick, and the head transition when that tenant's own claim reached the queue
-- head. Either raise aborts the whole tick.
--
-- Skipping the raise is not enough on its own. A non-terminal claim carrying
-- `apple_phase = 'update'` occupies the deployment-wide rendezvous, and the
-- sweep is the only thing that releases it. Leave it occupying and every other
-- account is refused the writer lease until the erasure finishes deleting it,
-- which advance can defer across many ticks. So the occupancy readers have to
-- agree with the sweep: a claim the sweep can no longer reach is a claim that no
-- longer holds the rendezvous.
--
-- That is safe for exactly one reason, asserted below rather than assumed: an
-- erasing owner's claim can never reserve. Every write to this table goes
-- through a security-definer RPC, every one of those is fenced while a
-- generation exists, and the generation outlives the row — the completion proof
-- counts this table, so the row is deleted before the fence can ever lift.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Both tenants abandoned an unresolved Apple write an hour ago. `updated_at` is
-- set explicitly because the maintenance trigger fires on update, not insert.
insert into public.included_offer_device_claims (
  claim_id, user_id, idempotency_key, app_attest_key_id,
  state, apple_phase, updated_at
)
values
  (
    '58800000-0000-4000-8000-000000000001',
    'user_588_healthy', 'idem-588-healthy', 'key-588-healthy',
    'apple_pending', 'update', now() - interval '1 hour'
  ),
  (
    '58800000-0000-4000-8000-000000000002',
    'user_588_erasing', 'idem-588-erasing', 'key-588-erasing',
    'apple_pending', 'update', now() - interval '1 hour'
  ),
  -- A second healthy claim that never reached Apple. It is the one the worker
  -- would open next, and it occupies nothing while it waits.
  (
    '58800000-0000-4000-8000-000000000003',
    'user_588_healthy', 'idem-588-next', 'key-588-next',
    'queued', null, now() - interval '1 hour'
  );

select public.begin_account_erasure(
  'user_588_erasing', '58800000-0000-4000-8000-0000000000ff'
);

-- The sweep and both occupancy readers are deployment-wide with no user
-- predicate, so a stray open claim from anywhere else in the database would
-- decide the assertions below instead of the fixtures. Fail loudly here rather
-- than passing quietly for the wrong reason.
select is(
  (
    select count(*)::integer
    from public.included_offer_device_claims claim
    where claim.apple_phase = 'update'
      and claim.state not in (
        'reserved', 'denied_device_consumed', 'denied_apple_unavailable'
      )
      and claim.claim_id not in (
        '58800000-0000-4000-8000-000000000001',
        '58800000-0000-4000-8000-000000000002'
      )
  ),
  0,
  'no unresolved rendezvous outside this file can decide the assertions below'
);

create temporary table included_offer_588_swept (claim_id uuid primary key)
  on commit drop;

insert into included_offer_588_swept (claim_id)
select swept
from public.expire_stale_included_offer_rendezvous(
  now() + interval '1 minute'
) swept;

select ok(
  (
    select exists (
      select 1 from included_offer_588_swept
      where claim_id = '58800000-0000-4000-8000-000000000001'
    )
  ),
  'the sweep still advances a healthy tenant''s stale rendezvous while an erasing tenant''s row sits in the same set'
);
select ok(
  (
    select not exists (
      select 1 from included_offer_588_swept
      where claim_id = '58800000-0000-4000-8000-000000000002'
    )
  ),
  'the sweep skips the erasing owner''s row instead of failing the whole sweep on it'
);
select is(
  (
    select claim.state
    from public.included_offer_device_claims claim
    where claim.claim_id = '58800000-0000-4000-8000-000000000001'
  ),
  'denied_apple_unavailable',
  'the healthy tenant''s claim is terminalized, not merely unblocked'
);
select is(
  (
    select claim.state || '/' || coalesce(claim.apple_phase, 'null')
    from public.included_offer_device_claims claim
    where claim.claim_id = '58800000-0000-4000-8000-000000000002'
  ),
  'apple_pending/update',
  'the erasing owner''s row is left untouched: erasure deletes it, the worker does not write it'
);

-- Liveness. With the erasing owner's row skipped by the sweep, nothing else
-- will ever terminalize it, so the readers that gate the next account have to
-- stop counting it. Otherwise the 500 simply becomes a silent stall of the same
-- length.
select is(
  public.has_open_included_offer_rendezvous(
    '58800000-0000-4000-8000-000000000003'
  ),
  false,
  'a claim the sweep can no longer reach no longer occupies the rendezvous'
);
select is(
  public.acquire_included_offer_writer_lease(
    '58800000-0000-4000-8000-000000000003', 30
  ),
  true,
  'the next account can still take the single-writer lease during another tenant''s erasure'
);

-- The head transition. Returning null here would be indistinguishable from an
-- ordinary state-guard miss, so the refusal is a value the worker can record.
select is(
  public.transition_included_offer_claim(
    '58800000-0000-4000-8000-000000000002',
    array['queued', 'awaiting_device_token', 'apple_pending', 'reconcile_required'],
    'awaiting_device_token'
  ),
  jsonb_build_object('outcome', 'account_erasure_in_progress'),
  'the head transition on an erasing owner''s claim resolves with a recorded outcome instead of aborting the tick'
);
select is(
  (
    select claim.state
    from public.included_offer_device_claims claim
    where claim.claim_id = '58800000-0000-4000-8000-000000000002'
  ),
  'apple_pending',
  'the refused transition writes nothing'
);

-- The safety proof for ignoring that row in the occupancy readers above. It is
-- released from the rendezvous precisely because it can never take the offer.
select is(
  public.transition_included_offer_claim(
    '58800000-0000-4000-8000-000000000002',
    array['queued', 'awaiting_device_token', 'apple_pending', 'reconcile_required'],
    'reserved'
  ),
  jsonb_build_object('outcome', 'account_erasure_in_progress'),
  'an erasing owner''s claim can never reserve, which is what makes releasing it safe'
);

select is(
  public.transition_included_offer_claim(
    '58800000-0000-4000-8000-000000000003',
    array['queued'],
    'awaiting_device_token'
  )->>'state',
  'awaiting_device_token',
  'a healthy tenant''s transition still applies'
);

-- The escape is scoped to the worker's sweep and transition paths. An ordinary
-- write to the same row — one the state machine would otherwise accept — is
-- still refused.
select throws_ok(
  $$
    update public.included_offer_device_claims
    set attempt_count = attempt_count + 1
    where claim_id = '58800000-0000-4000-8000-000000000002'
  $$,
  '55000',
  'Account erasure has started for this account',
  'the fence still refuses ordinary tenant writes during erasure'
);

-- #586's completion proof still has to see this row, or the erasure it belongs
-- to would report a finished deletion with the claim still present.
select is(
  private.account_erasure_owned_row_count('user_588_erasing'),
  1,
  'the erasing tenant''s claim is still counted by the account-erasure completion proof'
);

select * from finish();

rollback;

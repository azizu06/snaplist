begin;

select plan(43);

-- Issue #384: erase one signed-in account durably and idempotently.
--
-- Every span anchors to now(), which is transaction_timestamp(), so nothing in
-- this file expires at a calendar rollover. The whole contract runs inside one
-- rolled-back transaction, so the fixtures never touch a shared database.

-- The RPCs are the service-role deletion capability. Present the claims a
-- worker would arrive with; a seller must never reach them.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.function_privs_are(
  'public', 'begin_account_erasure', array['text', 'uuid'], 'authenticated',
  array[]::text[], 'a seller cannot start an erasure of any account'
);
select extensions.function_privs_are(
  'public', 'begin_account_erasure', array['text', 'uuid'], 'anon',
  array[]::text[], 'an unauthenticated caller cannot start an erasure'
);
select extensions.function_privs_are(
  'public', 'finalize_account_erasure',
  array['uuid', 'boolean', 'boolean', 'text[]'], 'authenticated',
  array[]::text[], 'a seller cannot declare their own erasure complete'
);
select extensions.function_privs_are(
  'private', 'prune_account_erasure_receipts', array['timestamptz'],
  'service_role', array[]::text[],
  'the receipt retention job is not reachable through the API'
);

-- ---------------------------------------------------------------------------
-- One key, one generation, one status.
-- ---------------------------------------------------------------------------

insert into public.user_settings (user_id)
values ('user_384_owner'), ('user_384_foreign');

select is(
  (select public.begin_account_erasure('user_384_owner', '38400000-0000-4000-8000-000000000001')->>'generation_id'),
  (select public.begin_account_erasure('user_384_owner', '38400000-0000-4000-8000-000000000001')->>'generation_id'),
  'a replayed Idempotency-Key resolves to the generation it already started'
);
select is(
  (
    select count(*)::integer
    from private.account_erasure_generations generation
    where generation.user_id_digest = private.account_erasure_user_digest('user_384_owner')
  ),
  1,
  'the replay creates no second generation'
);
-- Absent identity is null, not an object holding a null. advance is what
-- captures clerk_user_id, so the payload begin returns has none yet — and a
-- client that rejects the shape fails *after* the generation committed and
-- started fencing, leaving the account unwritable and unerasable.
select is(
  (
    select public.begin_account_erasure('user_384_owner', '38400000-0000-4000-8000-000000000001')->'identity'
  ),
  'null'::jsonb,
  'a generation with no captured identity yet reports none, not a null inside one'
);
select throws_ok(
  $$select public.begin_account_erasure('user_384_owner', '38400000-0000-4000-8000-0000000000ff')$$,
  '23505',
  'Account erasure Idempotency-Key is already bound',
  'a different key cannot start a second erasure of the same account'
);
select throws_ok(
  $$select public.begin_account_erasure('user_384_owner', null)$$,
  '22023',
  'Account erasure Idempotency-Key is required',
  'an erasure without a key has nothing to make a retry safe'
);

-- ---------------------------------------------------------------------------
-- New tenant work fails closed the moment deletion starts, and only for the
-- account being erased.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$update public.user_settings set autopilot_enabled = false where user_id = 'user_384_owner'$$,
  '55000',
  null,
  'a write to the erasing account is refused'
);
select lives_ok(
  $$insert into public.user_settings (user_id) values ('user_384_bystander')$$,
  'an unrelated account keeps writing while another account is erased'
);
select is(
  (
    select count(*)::integer from pg_trigger fence
    join pg_class c on c.oid = fence.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_trigger other
      on other.tgrelid = fence.tgrelid
     and not other.tgisinternal
     and (other.tgtype & 2) = 2
     and other.tgname > fence.tgname
    where fence.tgname = 'zzz_fence_account_erasure_tenant_mutation'
  ),
  0,
  'no BEFORE row trigger sorts after the fence, so it stays the last lock taken'
);
select extensions.doesnt_match(
  (
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'assert_account_erasure_mutation_allowed'
  ),
  'pg_advisory',
  'the fence takes no lock, so it cannot serialize sellers who are not erasing'
);

-- ---------------------------------------------------------------------------
-- Completion is proved, never asserted.
-- ---------------------------------------------------------------------------

select is(
  (
    select public.advance_account_erasure(
      (select generation_id from private.account_erasure_generations
       where user_id = 'user_384_owner')
    )->>'status'
  ),
  'deletion_in_progress',
  'advancing past the tenant rows is progress, not completion'
);
select is(
  private.account_erasure_owned_row_count('user_384_owner'),
  0,
  'the erased account owns no row the completion proof can still count'
);
select is(
  private.account_erasure_owned_row_count('user_384_foreign'),
  1,
  'the untouched account keeps every row it owned'
);

-- A write that raced the generation commit lands behind the fence. Completion
-- must notice it rather than reporting a deletion that did not happen.
savepoint racing_write;
select set_config('app.account_erasure_internal', 'true', true);
insert into public.user_settings (user_id) values ('user_384_owner');
select set_config('app.account_erasure_internal', 'false', true);
select throws_ok(
  $$select public.finalize_account_erasure(
      (select generation_id from private.account_erasure_generations where user_id = 'user_384_owner'),
      true, true
    )$$,
  '55000',
  'Mandatory account erasure work is incomplete',
  'completion is refused while an owned row survives'
);
rollback to savepoint racing_write;

select throws_ok(
  $$select public.finalize_account_erasure(
      (select generation_id from private.account_erasure_generations where user_id = 'user_384_owner'),
      false, true
    )$$,
  '55000',
  'Clerk identity absence is not proved',
  'an unobserved provider deletion cannot finish the erasure'
);

-- Provider-owned deletion that could not be observed is a state of its own, and
-- it is not terminal: the work resumes.
select is(
  (
    select public.finalize_account_erasure(
      (select generation_id from private.account_erasure_generations where user_id = 'user_384_owner'),
      false, false, array['clerk-identity-deletion-unverified']
    )->>'status'
  ),
  'deletion_needs_attention',
  'unproved provider absence lands in deletion_needs_attention'
);
select is(
  (
    select attention_reasons from private.account_erasure_generations
    where user_id = 'user_384_owner'
  ),
  array['clerk-identity-deletion-unverified'],
  'the reason it needs attention is recorded, not just the status'
);

-- ---------------------------------------------------------------------------
-- Resuming. advance runs again on every retry, so it has to be idempotent
-- against a generation that already advanced — the state a crash between
-- advance and finalize leaves behind. These four assertions are the ones that
-- were missing when both review axes found the resume path broken.
-- ---------------------------------------------------------------------------

savepoint resume_paths;

-- A retry while the erasure needs attention must be able to leave that state.
-- The reasons are tied to the status by a biconditional, so an advance that
-- leaves them attached strands the account with no reachable terminal status.
select lives_ok(
  $$select public.advance_account_erasure(
      (select generation_id from private.account_erasure_generations where user_id = 'user_384_owner')
    )$$,
  'an erasure that needs attention can be advanced again rather than stranded'
);
select is(
  (
    select attention_reasons from private.account_erasure_generations
    where user_id = 'user_384_owner'
  ),
  '{}'::text[],
  'advancing clears the reasons it is no longer blocked on'
);

-- advance recomputes the retained records and provider ids from rows a previous
-- pass already deleted, so they must accumulate. Overwriting them lets a
-- crash-and-retry drop the RevenueCat id, which drops finalize's proof
-- requirement with it and completes flat while the customer still exists.
insert into public.user_settings (user_id) values ('user_384_resume');
insert into public.revenuecat_customer_bindings (user_id, revenuecat_app_user_id)
values ('user_384_resume', 'rc_384_resume');
select public.begin_account_erasure('user_384_resume', '38400000-0000-4000-8000-000000000003');
select public.advance_account_erasure(
  (select generation_id from private.account_erasure_generations where user_id = 'user_384_resume')
);
select public.advance_account_erasure(
  (select generation_id from private.account_erasure_generations where user_id = 'user_384_resume')
);
select is(
  (
    select revenuecat_app_user_ids from private.account_erasure_generations
    where user_id = 'user_384_resume'
  ),
  array['rc_384_resume'],
  'a second advance keeps the provider id the first one captured'
);
select throws_ok(
  $$select public.finalize_account_erasure(
      (select generation_id from private.account_erasure_generations where user_id = 'user_384_resume'),
      true, false
    )$$,
  '55000',
  'RevenueCat customer absence is not proved',
  'so completion still demands the provider proof after a resume'
);

rollback to savepoint resume_paths;

-- ---------------------------------------------------------------------------
-- Completion scrubs every raw identifier, and keeps fencing afterwards.
-- ---------------------------------------------------------------------------

select is(
  (
    select public.finalize_account_erasure(
      (select generation_id from private.account_erasure_generations where user_id = 'user_384_owner'),
      true, true
    )->>'status'
  ),
  'deletion_completed',
  'an erasure that resumed from needing attention can still complete'
);
select is(
  (
    select row(user_id, idempotency_key, clerk_user_id, revenuecat_app_user_ids, attention_reasons)::text
    from private.account_erasure_generations
    where user_id_digest = private.account_erasure_user_digest('user_384_owner')
  ),
  row(null::text, null::uuid, null::text, '{}'::text[], '{}'::text[])::text,
  'completion leaves a one-way digest and no raw identifier at all'
);
select throws_ok(
  $$insert into public.user_settings (user_id) values ('user_384_owner')$$,
  '55000',
  null,
  'the account stays fenced after completion, so nothing reappears under it'
);
select is(
  (
    select to_jsonb(settings) - 'updated_at'
    from public.user_settings settings where user_id = 'user_384_foreign'
  ),
  (
    select to_jsonb(settings) - 'updated_at'
    from public.user_settings settings where user_id = 'user_384_bystander'
  )
  || jsonb_build_object('user_id', 'user_384_foreign'),
  'the other tenants are unchanged by a completed erasure of their neighbour'
);

-- The scrub is a database constraint rather than a convention in one branch of
-- one function, so no future writer can complete an erasure while the raw
-- identifiers are still attached.
select throws_ok(
  $$update private.account_erasure_generations
    set user_id = 'user_384_owner'
    where user_id_digest = private.account_erasure_user_digest('user_384_owner')$$,
  '23514',
  null,
  'a completed receipt cannot be given its raw identifiers back'
);

-- A replayed finalize has to answer with the status it already wrote and touch
-- nothing. If it re-stamped completed_at, every retry would slide the receipt's
-- 30-day prune deadline forward and the record would outlive its own contract.
-- (`finalize` and `advance` each re-check the terminal statuses a second time
-- once they hold the row lock. That second check only fires when a concurrent
-- call completed the generation during the lock wait, which a single-session
-- contract like this one cannot stage; what is proved here is the same-session
-- replay that returns before taking the lock at all.)
create temporary table erasure_384_replay on commit drop as
select completed_at
from private.account_erasure_generations
where user_id_digest = private.account_erasure_user_digest('user_384_owner');

select is(
  (
    select public.finalize_account_erasure(
      (
        select generation_id from private.account_erasure_generations
        where user_id_digest = private.account_erasure_user_digest('user_384_owner')
      ),
      true, true
    )->>'status'
  ),
  'deletion_completed',
  'a replayed finalize answers with the status it already wrote'
);
select is(
  (
    select completed_at from private.account_erasure_generations
    where user_id_digest = private.account_erasure_user_digest('user_384_owner')
  ),
  (select completed_at from erasure_384_replay),
  'the replay leaves the receipt''s prune deadline exactly where it was'
);

-- ---------------------------------------------------------------------------
-- The receipt expires on its own clock. docs/contracts/lean-mvp-retention-v1.json
-- holds the row this proves.
-- ---------------------------------------------------------------------------

select is(
  private.prune_account_erasure_receipts(now() + interval '29 days'),
  0,
  'a receipt inside the window is kept, so a late retry still resolves'
);
select is(
  private.prune_account_erasure_receipts(now() + interval '31 days'),
  1,
  'a receipt past the window is pruned'
);
select is(
  (
    select count(*)::integer from private.account_erasure_generations
    where user_id_digest = private.account_erasure_user_digest('user_384_owner')
  ),
  0,
  'nothing keyed to the erased account outlives its retention window'
);
select is(
  (
    select schedule from cron.job
    where jobname = 'snaplist-account-erasure-receipt-retention-daily'
  ),
  '41 3 * * *',
  'the receipt retention job is registered, so the window is enforced unattended'
);

-- ---------------------------------------------------------------------------
-- Coverage. Erasure is only as complete as its table list, and that list is
-- what a future migration silently invalidates: add a tenant table, forget the
-- fence, and erasure keeps reporting completion while the new rows survive.
-- Derive the expectation from the catalog rather than restating it.
--
-- CI builds this database from this branch's migrations alone, so the catalog
-- is exactly the tree. A long-lived local database shared between worktrees is
-- not: it can also carry a table from a branch this tree has never seen, and
-- these two assertions will name it. That is the guard reporting a real future
-- obligation early — when that branch merges, its tenant table has to be fenced
-- and counted here — rather than a defect in the branch under test.
-- ---------------------------------------------------------------------------

create temporary table erasure_scope on commit drop as
select distinct c.table_schema || '.' || c.table_name as qualified
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema
 and t.table_name = c.table_name
 and t.table_type = 'BASE TABLE'
where c.table_schema in ('public', 'private')
  and c.column_name in (
    'user_id', 'guest_user_id', 'claim_target_user_id',
    'claim_idempotency_user_id', 'storage_path', 'photo_paths'
  )
  -- The receipt is not tenant data. It is erasure's own record of itself: it
  -- outlives the account on purpose so replay and the fence keep answering,
  -- and it is removed by its own retention job. Fencing or counting it would
  -- make erasure unable to finish.
  and c.table_schema || '.' || c.table_name <> 'private.account_erasure_generations';

select cmp_ok(
  (select count(*)::integer from erasure_scope), '>', 20,
  'the derived scope is populated, so the two assertions below mean something'
);
select is(
  (
    select coalesce(array_agg(scope.qualified order by scope.qualified), '{}')
    from erasure_scope scope
    where not exists (
      select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where t.tgname = 'zzz_fence_account_erasure_tenant_mutation'
        and n.nspname || '.' || c.relname = scope.qualified
    )
  ),
  '{}'::text[],
  'every tenant table refuses writes once its owner is being erased'
);
select is(
  (
    select coalesce(array_agg(scope.qualified order by scope.qualified), '{}')
    from erasure_scope scope
    where position('from ' || scope.qualified in (
      select pg_get_functiondef(p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'account_erasure_owned_row_count'
    )) = 0
  ),
  '{}'::text[],
  'every tenant table is counted by the proof that says deletion finished'
);

-- Storage objects are fenced by the same rule; a bucket write during erasure is
-- tenant data arriving after the deletion was promised.
select extensions.has_trigger(
  'storage', 'objects', 'zzz_fence_account_erasure_storage_object',
  'private Storage refuses new objects for an account being erased'
);

-- ---------------------------------------------------------------------------
-- What that coverage means for the newest tenant table. `public.export_handoffs`
-- (migration 20260731040000) holds a seller's assisted-export receipts — their
-- own claim that they posted a pack to Facebook, Mercari, or Depop. Its rows
-- cascade from `listings` and `items`, so they were already going away; what was
-- missing is that erasure never REFUSED one, and never counted one. Both are
-- asserted as behaviour here, not just as catalog wiring above.
-- ---------------------------------------------------------------------------

savepoint export_receipt;
insert into public.user_settings (user_id) values ('user_384_export');
insert into public.items (
  id, user_id, review_content_revision, photo_identity_kind, photo_identity_fingerprint
)
values (
  '38400000-0000-4000-8000-0000000000e1', 'user_384_export',
  '38400000-0000-4000-8000-0000000000e3', 'content_sha256_set_v1', repeat('e', 64)
);
insert into public.listings (id, user_id, item_id, platform, source_review_revision)
values (
  '38400000-0000-4000-8000-0000000000e2', 'user_384_export',
  '38400000-0000-4000-8000-0000000000e1', 'depop',
  '38400000-0000-4000-8000-0000000000e3'
);
insert into public.export_handoffs (
  user_id, item_id, platform, source_review_revision, handoff_at, shared_at
)
values (
  'user_384_export', '38400000-0000-4000-8000-0000000000e1', 'depop',
  '38400000-0000-4000-8000-0000000000e3', now(), now()
);
select public.begin_account_erasure(
  'user_384_export', '38400000-0000-4000-8000-0000000000e4'
);
select throws_ok(
  $$insert into public.export_handoffs (
      user_id, item_id, platform, source_review_revision, handoff_at
    )
    values (
      'user_384_export', '38400000-0000-4000-8000-0000000000e1', 'facebook',
      '38400000-0000-4000-8000-0000000000e3', now()
    )$$,
  '55000',
  null,
  'a seller cannot record a new export receipt into an account already being erased'
);
select public.advance_account_erasure(
  (select generation_id from private.account_erasure_generations
   where user_id = 'user_384_export')
);
select is(
  private.account_erasure_owned_row_count('user_384_export'),
  0,
  'the export receipts the completion proof now counts are gone before it counts them'
);
rollback to savepoint export_receipt;

-- ---------------------------------------------------------------------------
-- A guest copy mid-flight owns rows in two tenants at once. Erasure waits for
-- it rather than racing it, so a claim cannot land rows into an account whose
-- deletion already reported complete.
-- ---------------------------------------------------------------------------

savepoint claim_in_flight;
insert into private.guest_draft_recoveries (
  id, guest_user_id, pipeline_run_id, item_id, draft_id, reservation_id,
  allowance_period_id, recovery_token_hash, storage_object_count,
  encrypted_artifact, storage_manifest,
  usable_draft_at, expires_at, state, claim_target_user_id,
  claim_lease_token, claim_lease_expires_at
)
values (
  '38400000-0000-4000-8000-0000000000a1', 'guest_384',
  '38400000-0000-4000-8000-0000000000a2', '38400000-0000-4000-8000-0000000000a3',
  '38400000-0000-4000-8000-0000000000a4', '38400000-0000-4000-8000-0000000000a5',
  '38400000-0000-4000-8000-0000000000a6', repeat('a', 64), 1,
  '{}'::jsonb, '[]'::jsonb,
  now(), now() + interval '24 hours', 'copying', 'user_384_claimer',
  '38400000-0000-4000-8000-0000000000a7', now() + interval '5 minutes'
);
select throws_ok(
  $$select public.begin_account_erasure('user_384_claimer', '38400000-0000-4000-8000-000000000002')$$,
  '55000',
  'Guest claim must settle before account erasure starts',
  'erasure will not start underneath a guest claim that is still copying'
);
rollback to savepoint claim_in_flight;

select lives_ok(
  $$select public.begin_account_erasure('user_384_claimer', '38400000-0000-4000-8000-000000000002')$$,
  'once the claim settles, the same key starts the erasure it was holding'
);

select * from finish();
rollback;

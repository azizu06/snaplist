-- INACTIVE OWNER-ONLY TEMPLATE. This file is never applied by migrations.
-- OWNER MUST REPLACE both placeholder values, inspect them locally, and run
-- this manually only after approving hosted activation. Never commit values.
--
-- Required extensions in the target project:
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   create extension if not exists supabase_vault;
--
-- The origin is normalized with rtrim(..., '/') on purpose. A stored origin
-- ending in '/' would build '<origin>//api/internal/...', which Next.js answers
-- with a 308 to the normalized path. pg_net follows that redirect and records a
-- 200, so the schedule would look healthy while the request never reached the
-- route. Verified locally: 'http://host:3000//api/internal/pipeline-worker'
-- returns 308.
--
-- vault.create_secret fails if the name already exists. To ROTATE rather than
-- create, use vault.update_secret(id, new_secret) with the id from
-- `select id, name from vault.secrets where name like 'snaplist_pipeline_%'`.

select vault.create_secret(
  '<owner-supplied-https-origin>',
  'snaplist_pipeline_origin',
  'OWNER MUST REPLACE with the deployed SnapList HTTPS origin'
);
select vault.create_secret(
  '<owner-supplied-cron-secret>',
  'snaplist_pipeline_cron_secret',
  'OWNER MUST REPLACE with the same unlogged CRON_SECRET used by the app'
);

-- One five-minute-bounded worker invocation per minute. Each request claims one
-- message so that run receives the full PGMQ visibility/DB lease window.
select cron.schedule(
  'snaplist-pipeline-worker',
  '* * * * *',
  $worker$
    select net.http_post(
      url := rtrim((
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'snaplist_pipeline_origin'
      ), '/') || '/api/internal/pipeline-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'snaplist_pipeline_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 290000
    );
  $worker$
);

-- Cleanup is bounded to 25 jobs and runs away from the top of the hour.
select cron.schedule(
  'snaplist-pipeline-maintenance',
  '17 * * * *',
  $maintenance$
    select net.http_post(
      url := rtrim((
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'snaplist_pipeline_origin'
      ), '/') || '/api/internal/pipeline-maintenance',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'snaplist_pipeline_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 290000
    );
  $maintenance$
);

-- Issue #524. The included-offer redemption queue has exactly one writer, and
-- this advances one head claim per tick and no more. What enforces that is the
-- singleton row behind `acquire_included_offer_writer_lease`, not this
-- schedule: a minute cadence against a 290s timeout means pg_cron can and will
-- start a tick while the last one is still running, and the extra tick simply
-- fails to take the lease and returns. Until some tick runs, no claim ever
-- reaches `device_token_required`, so the promotion is unreachable however
-- correct the rest of the fence is — this schedule is what makes it
-- obtainable. A seller polls their claim while waiting, so this cadence bounds
-- how long that wait can be; an owner who wants it tighter can use pg_cron's
-- sub-minute interval syntax instead of the cron expression.
select cron.schedule(
  'snaplist-included-offer-worker',
  '* * * * *',
  $included_offer$
    select net.http_post(
      url := rtrim((
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'snaplist_pipeline_origin'
      ), '/') || '/api/internal/included-offer-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'snaplist_pipeline_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 290000
    );
  $included_offer$
);

-- Safe disable/rollback (run manually; leaves queue/run truth intact):
-- select cron.unschedule('snaplist-pipeline-worker');
-- select cron.unschedule('snaplist-pipeline-maintenance');
-- select cron.unschedule('snaplist-included-offer-worker');

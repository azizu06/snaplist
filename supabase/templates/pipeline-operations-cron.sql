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

-- Safe disable/rollback (run manually; leaves queue/run truth intact):
-- select cron.unschedule('snaplist-pipeline-worker');
-- select cron.unschedule('snaplist-pipeline-maintenance');

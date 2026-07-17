-- INACTIVE OWNER-ONLY TEMPLATE. This file is never applied by migrations.
-- OWNER MUST REPLACE both placeholder values, inspect them locally, and run
-- this manually only after approving hosted activation. Never commit values.
--
-- Required extensions in the target project:
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   create extension if not exists supabase_vault;

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

-- One five-minute-bounded worker invocation per minute. The worker claims only
-- five messages and PGMQ visibility/DB leases fence overlapping deliveries.
select cron.schedule(
  'snaplist-pipeline-worker',
  '* * * * *',
  $worker$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'snaplist_pipeline_origin'
      ) || '/api/internal/pipeline-worker',
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
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'snaplist_pipeline_origin'
      ) || '/api/internal/pipeline-maintenance',
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

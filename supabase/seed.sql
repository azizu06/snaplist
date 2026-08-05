-- SnapList — local seed (runs on `pnpm supabase db reset`, per config.toml db.seed).
--
-- The PRD calls for a seeded pgvector reference corpus from day one. That corpus is
-- owned by the service role (not a normal tenant) and its rows carry a user_id, so
-- meaningful seeding happens once auth users exist (a later slice provides the seed
-- script + embeddings). Keeping this file present and valid means `db reset` runs
-- clean today; corpus INSERTs land here when the embedding pipeline exists.
--
-- This value is public, local-only test configuration. Hosted environments stay
-- unprovisioned until the operator follows the migration runbook with a distinct
-- high-entropy SERVER_RPC_SECRET.
insert into private.server_rpc_auth_config (singleton, secret_sha256)
values (
  true,
  encode(
    extensions.digest(
      convert_to(
        'snaplist-local-server-rpc-secret-do-not-use-in-hosted',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
)
on conflict (singleton) do update
set secret_sha256 = excluded.secret_sha256,
    provisioned_at = statement_timestamp();

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    "supabase/migrations/20260720014000_bounded_mobile_run_replays.sql",
  ),
  "utf8",
);

const nullOperationGuardMigration = readFileSync(
  resolve(
    "supabase/migrations/20260720070000_reject_null_mobile_run_operation.sql",
  ),
  "utf8",
);

describe("mobile durable-run mutation idempotency migration", () => {
  it("rejects a null operation through the public invalid-input contract", () => {
    expect(nullOperationGuardMigration).toMatch(
      /p_operation is null[\s\S]*errcode = '22023'[\s\S]*message = 'Invalid mobile run operation'/i,
    );
  });

  it("binds one tenant key to one run operation before invoking #161", () => {
    expect(migration).toMatch(
      /create table private\.mobile_run_operation_replays/i,
    );
    expect(migration).toMatch(/primary key \(user_id, idempotency_key\)/i);
    expect(migration).toMatch(/requested_run_id uuid not null/i);
    expect(migration).toMatch(
      /run_id uuid not null references public\.pipeline_runs \(id\) on delete cascade/i,
    );
    expect(migration).toMatch(/public\.clerk_user_id\(\)/i);
    expect(migration).toMatch(/pg_advisory_xact_lock/i);
    expect(migration).toMatch(
      /p_run_id is distinct from v_replay\.requested_run_id[\s\S]*p_operation is distinct from v_replay\.operation/i,
    );
    expect(migration).toMatch(/public\.retry_pipeline_run\(p_run_id\)/i);
    expect(migration).toMatch(/public\.cancel_pipeline_run\(p_run_id\)/i);
    expect(migration).not.toMatch(/v_reservation_state = 'restored'/i);
    expect(migration).toMatch(
      /requested_run_id,[\s\S]*run_id,[\s\S]*p_run_id,[\s\S]*v_locked_run_id/i,
    );
    expect(migration).toMatch(
      /for update;[\s\S]*?if not found then\s*return jsonb_build_object\([\s\S]*'P0002'[\s\S]*end if;\s*select count\(\*\)::integer[\s\S]*begin\s*if p_operation = 'retry'[\s\S]*exception[\s\S]*insert into private\.mobile_run_operation_replays/i,
    );
    expect(migration).toMatch(/v_replay_limit constant integer := 32/i);
    expect(migration).toMatch(
      /from public\.pipeline_runs[\s\S]*for update[\s\S]*count\(\*\)[\s\S]*v_replay_count >= v_replay_limit[\s\S]*too many saved operation receipts[\s\S]*public\.retry_pipeline_run\(p_run_id\)/i,
    );
  });

  it("preserves #278 retention-first retry ordering", () => {
    expect(migration).toMatch(
      /p_operation = 'retry'[\s\S]*snaplist:pipeline-retention[\s\S]*from public\.pipeline_runs[\s\S]*for update[\s\S]*public\.retry_pipeline_run\(p_run_id\)/i,
    );
  });

  it("keeps the replay ledger private and exposes only the authenticated wrapper", () => {
    expect(migration).toMatch(
      /revoke all on table private\.mobile_run_operation_replays[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.apply_mobile_run_operation\(uuid, text, uuid\)[\s\S]*to authenticated/i,
    );
  });
});

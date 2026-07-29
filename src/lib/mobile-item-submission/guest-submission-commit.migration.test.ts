import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  "supabase/migrations/20260728160000_authenticated_guest_submission_commit.sql",
);
const creditLedgerMigrationPath = resolve(
  "supabase/migrations/20260716180000_ai_item_credit_ledger.sql",
);
const publicSelectorPath = resolve(
  "src/lib/mobile-item-submission/guest-first-run.rls.test.ts",
);

describe("authenticated guest submission commit migration", () => {
  it("observes denied-run credit effects through the durable pipeline relationship", () => {
    const creditLedgerMigration = readFileSync(creditLedgerMigrationPath, "utf8");
    const publicSelector = readFileSync(publicSelectorPath, "utf8");

    expect(creditLedgerMigration).toMatch(
      /create table public\.ai_item_credit_reservations[\s\S]*pipeline_run_id uuid not null unique/i,
    );
    expect(publicSelector).toMatch(
      /from public\.ai_item_credit_reservations credit\s+join public\.pipeline_runs run on run\.id = credit\.pipeline_run_id/i,
    );
    expect(publicSelector).not.toMatch(/run\.id = credit\.run_id/i);
  });

  it("queues an authorized guest run through one ungranted subject core", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const subjectStage = migration.match(
      /create or replace function public\.stage_pipeline_batch\(\s*p_user_id text,\s*p_batch_id uuid,\s*p_entries jsonb,\s*p_daily_limit integer,\s*p_per_minute_limit integer\s*\)[\s\S]*?\n\$\$;/i,
    )?.[0];

    expect(subjectStage).toBeDefined();
    expect(subjectStage).toMatch(
      /private\.enqueue_pipeline_message_for_subject\(\s*p_user_id,\s*v_run_id,\s*1::smallint\s*\)/i,
    );
    expect(subjectStage).not.toMatch(/public\.enqueue_pipeline_message/i);
    expect(migration).toMatch(
      /create or replace function private\.enqueue_pipeline_message_for_subject\(\s*p_user_id text,\s*p_run_id uuid,\s*p_schema_version smallint\s*\)[\s\S]*security definer[\s\S]*set search_path = ''[\s\S]*run\.user_id = p_user_id[\s\S]*pgmq\.send\(/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.enqueue_pipeline_message\(\s*p_run_id uuid,\s*p_schema_version smallint\s*\)[\s\S]*coalesce\(auth\.jwt\(\)->>'role', ''\) <> 'service_role'[\s\S]*private\.enqueue_pipeline_message_for_subject/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.enqueue_pipeline_message_for_subject\(\s*text, uuid, smallint\s*\)\s*from public, anon, authenticated, service_role/i,
    );
  });

  it("shares one atomic subject core while preserving the service capability", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /create or replace function private\.commit_mobile_item_submission_for_subject\(\s*p_user_id text,\s*p_idempotency_key uuid,\s*p_request_fingerprint text,\s*p_batch_id uuid,\s*p_cleanup_id uuid,\s*p_cost_basis numeric,\s*p_daily_limit integer,\s*p_per_minute_limit integer,\s*p_photo_identity jsonb,\s*p_photo_receipts jsonb\s*\)/i,
    );
    expect(migration).toMatch(
      /private\.commit_mobile_item_submission_for_subject[\s\S]*security definer[\s\S]*set search_path = ''/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.commit_mobile_item_submission_for_subject[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /submission\.user_id = p_user_id[\s\S]*submission\.idempotency_key = p_idempotency_key[\s\S]*for update/i,
    );
    expect(migration).toMatch(
      /char_length\(p_user_id \|\| '\/pipeline-staging\/' \|\| p_batch_id::text \|\| '\/0\/'\)[\s\S]*<> p_user_id \|\| '\/pipeline-staging\/' \|\| p_batch_id::text \|\| '\/0\/'/i,
    );
    expect(migration).toMatch(
      /public\.stage_pipeline_batch\(\s*p_user_id,\s*p_batch_id,[\s\S]*p_daily_limit,\s*p_per_minute_limit,\s*v_photo_identities\s*\)/i,
    );
    expect(migration).toMatch(
      /update private\.mobile_item_submissions[\s\S]*state = 'committed'[\s\S]*where submission\.user_id = p_user_id/i,
    );
    expect(migration).toMatch(
      /delete from private\.pipeline_staging_cleanup_intents[\s\S]*intent\.cleanup_id = p_cleanup_id[\s\S]*intent\.user_id = p_user_id[\s\S]*intent\.batch_id = p_batch_id/i,
    );
    expect(migration).toMatch(
      /get stacked diagnostics[\s\S]*message_text[\s\S]*AI item credit unavailable[\s\S]*denial_reason[\s\S]*return next/i,
    );

    expect(migration).toMatch(
      /create or replace function public\.commit_mobile_item_submission\(\s*p_user_id text,\s*p_idempotency_key uuid,\s*p_request_fingerprint text,\s*p_batch_id uuid,\s*p_cleanup_id uuid,\s*p_cost_basis numeric,\s*p_daily_limit integer,\s*p_per_minute_limit integer,\s*p_photo_identity jsonb,\s*p_photo_receipts jsonb\s*\)/i,
    );
    expect(migration).toMatch(
      /coalesce\(auth\.jwt\(\)->>'role', ''\) <> 'service_role'[\s\S]*private\.commit_mobile_item_submission_for_subject\(\s*p_user_id,/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.commit_mobile_item_submission\(\s*text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb\s*\)[\s\S]*to service_role/i,
    );

    expect(migration).toMatch(
      /create or replace function public\.commit_mobile_item_submission\(\s*p_idempotency_key uuid,\s*p_request_fingerprint text,\s*p_batch_id uuid,\s*p_cleanup_id uuid,\s*p_cost_basis numeric,\s*p_daily_limit integer,\s*p_per_minute_limit integer,\s*p_photo_identity jsonb,\s*p_photo_receipts jsonb\s*\)/i,
    );
    expect(migration).toMatch(
      /v_user_id text := private\.assert_verified_guest_capability\(\)/i,
    );
    expect(migration).toMatch(
      /private\.commit_mobile_item_submission_for_subject\(\s*v_user_id,/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.commit_mobile_item_submission\(\s*uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb\s*\)[\s\S]*to authenticated/i,
    );
    expect(migration).toMatch(
      /returns table \([\s\S]*denial_reason text[\s\S]*private\.commit_mobile_item_submission_for_subject\(\s*v_user_id,/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.resolve_pipeline_staging_cleanup_intent\(\s*p_cleanup_id uuid\s*\)[\s\S]*v_role <> 'service_role'[\s\S]*delete from private\.pipeline_staging_cleanup_intents[\s\S]*grant execute[\s\S]*to service_role;/i,
    );

    expect(migration).toMatch(
      /create or replace function public\.stage_pipeline_batch[\s\S]*private\.assert_verified_guest_capability\(\)[\s\S]*p_user_id is distinct from v_authorized_guest_user_id/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.stage_pipeline_batch[\s\S]*from public, anon, authenticated[\s\S]*grant execute[\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.stage_pipeline_batch\([^)]*\)\s*to authenticated/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*private\.(?:mobile_item_submissions|pipeline_staging_cleanup_intents|pipeline_run_usage_reservations)/i,
    );
    expect(migration).toMatch(
      /pipeline-daily:[\s\S]*pipeline-minute:[\s\S]*private\.pipeline_run_usage_reservations[\s\S]*insert into public\.items[\s\S]*insert into public\.pipeline_runs[\s\S]*private\.enqueue_pipeline_message_for_subject/i,
    );
    expect(migration).toMatch(
      /snaplist\.verified_photo_identities[\s\S]*public\.stage_pipeline_batch\([\s\S]*revalidate while those transaction locks/i,
    );
  });
});

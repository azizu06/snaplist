import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260720003000_manual_retry_credit_reconciliation.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("manual retry AI-item credit reconciliation migration", () => {
  it("keeps one reservation and records retry accounting monotonically", () => {
    expect(migration).toMatch(/add column if not exists retry_reservation_count/i);
    expect(migration).toMatch(/add column if not exists retry_restore_count/i);
    expect(migration).toMatch(
      /old\.state = 'restored' and new\.state = 'settled'/i,
    );
    expect(migration).toMatch(
      /new\.retry_reservation_count = old\.retry_reservation_count \+ 1/i,
    );
    expect(migration).toMatch(
      /new\.retry_restore_count = old\.retry_restore_count \+ 1/i,
    );
    expect(
      migration.match(/insert into public\.ai_item_credit_reservations/g),
    ).toHaveLength(1);
  });

  it("reclaims the original allowance before retry changes the run or queue", () => {
    expect(migration).toMatch(
      /create or replace function private\.reserve_ai_item_credit_for_manual_retry/i,
    );
    expect(migration).toMatch(/hashtextextended\('ai-item-credit:' \|\| v_user_id/i);
    expect(migration).toMatch(/restored-allowance-reused/i);
    expect(migration).toMatch(
      /pg_advisory_xact_lock\([\s\S]*snaplist:pipeline-retention[\s\S]*for update[\s\S]*perform private\.reserve_ai_item_credit_for_manual_retry\(v_run\.id\)[\s\S]*update public\.pipeline_runs[\s\S]*pgmq\.send/i,
    );
  });

  it("reconciles active retries from the pre-migration RPC without overbooking", () => {
    expect(migration).toMatch(/manual-retry-upgrade-backfill:begin/i);
    expect(migration).toMatch(
      /run\.status in \('queued', 'running', 'retrying'\)[\s\S]*run\.capture_input is not null[\s\S]*run\.listing_id is null[\s\S]*run\.completed_at is null/i,
    );
    expect(migration).toMatch(
      /Cannot reconcile active manual retries without overbooking an AI-item allowance period/i,
    );
    expect(migration).toMatch(
      /update public\.ai_item_credit_reservations reservation[\s\S]*set retry_reservation_count = 1[\s\S]*from public\.pipeline_runs run/i,
    );
  });

  it("counts active retry reclaims in reservations and entitlement reads", () => {
    expect(migration).toMatch(
      /create or replace function private\.reserve_ai_item_credit_for_pipeline_run\(\)[\s\S]*retry_reservation_count > reservation\.retry_restore_count/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.get_verified_ai_item_entitlement/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.get_verified_ai_item_entitlement[\s\S]*where reservation\.state <> 'restored'[\s\S]*retry_reservation_count[\s\S]*retry_restore_count/i,
    );
  });

  it("preserves tenant authority and prevents a guest claim from taking an active retry slot", () => {
    expect(migration).toMatch(/public\.clerk_user_id\(\)/i);
    expect(migration).toMatch(/private\.guest_claim_credit_remap_allowed\(old, new\)/i);
    expect(migration).toMatch(/Account included credit is already bound to another run/i);
    expect(migration).toMatch(
      /revoke all on function private\.reserve_ai_item_credit_for_manual_retry\(uuid\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.retry_pipeline_run\(uuid\)[\s\S]*to authenticated/i,
    );
  });
});

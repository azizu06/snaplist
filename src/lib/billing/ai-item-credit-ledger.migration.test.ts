import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260716180000_ai_item_credit_ledger.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("AI-item credit ledger migration", () => {
  it("stores tenant-owned allowance periods and monotonic run reservations", () => {
    expect(migration).toMatch(/create table public\.ai_item_allowance_periods/i);
    expect(migration).toMatch(/create table public\.ai_item_credit_reservations/i);
    expect(migration).toMatch(/state text not null default 'reserved'/i);
    expect(migration).toMatch(/state in \('reserved', 'settled', 'restored'\)/i);
    expect(migration).toMatch(/pipeline_run_id uuid not null unique/i);
    expect(migration).toMatch(/logical_run_key text not null/i);
    expect(migration).toMatch(/photo_set_fingerprint text not null/i);
    expect(migration).toMatch(/enforce_ai_item_credit_transition/i);
  });

  it("uses indexed RLS ownership and exposes no tenant write authority", () => {
    for (const table of [
      "ai_item_allowance_periods",
      "ai_item_credit_reservations",
    ]) {
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`create policy ${table}_select_own[\\s\\S]+to authenticated`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`grant select on table public\\.${table} to authenticated`, "i"),
      );
      expect(migration).not.toMatch(
        new RegExp(`grant (?:insert|update|delete)[^;]+public\\.${table}[^;]+authenticated`, "i"),
      );
    }
    expect(migration).toMatch(/ai_item_allowance_periods_user_period_idx/i);
    expect(migration).toMatch(/ai_item_credit_reservations_user_state_idx/i);
  });

  it("accepts only server-verified StoreKit period events and advances them monotonically", () => {
    expect(migration).toMatch(
      /create or replace function public\.record_verified_storekit_ai_item_period/i,
    );
    expect(migration).toMatch(/private\.storekit_ai_item_period_events/i);
    expect(migration).toMatch(/pg_advisory_xact_lock/i);
    expect(migration).toMatch(/event_created_at/i);
    expect(migration).toMatch(/period_start/i);
    expect(migration).toMatch(/expires_date/i);
    expect(migration).toMatch(/grace_expires_date/i);
    expect(migration).toMatch(/'active', 'grace', 'billing_retry'/i);
    expect(migration).toMatch(
      /'expired', 'revoked', 'refunded',\s*'ambiguous'/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_verified_storekit_ai_item_period\([^;]+to service_role/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_verified_storekit_ai_item_period\([^;]+from public, anon, authenticated/i,
    );
  });

  it("reserves at durable staging and reuses the same logical run across delivery attempts", () => {
    expect(migration).toMatch(/create trigger reserve_ai_item_credit_for_pipeline_run/i);
    expect(migration).toMatch(/after insert on public\.pipeline_runs/i);
    expect(migration).toMatch(/new\.capture_input is null/i);
    expect(migration).toMatch(/new\.idempotency_key/i);
    expect(migration).toMatch(/new\.item_id/i);
    expect(migration).toMatch(/on conflict \(pipeline_run_id\)/i);
    expect(migration).toMatch(/included-first-run/i);
    expect(migration).toMatch(/enforce_credited_item_photo_set_immutable/i);
    expect(migration).toMatch(/before update of photos on public\.items/i);
  });

  it("settles only with one coherent editable draft revision and restores only before settlement", () => {
    expect(migration).toMatch(/private\.settle_ai_item_credit/i);
    expect(migration).toMatch(/source_review_revision/i);
    expect(migration).toMatch(/array_to_json\(item\.photos\)/i);
    expect(migration).toMatch(/prediction_logs/i);
    expect(migration).toMatch(/status in \('draft', 'queued'\)/i);
    expect(migration).toMatch(/private\.restore_ai_item_credit/i);
    expect(migration).toMatch(/state = 'reserved'/i);
    expect(migration).toMatch(/release_pipeline_run_quota_if_available/i);
    expect(migration).toMatch(/finalize_ai_item_credit_from_pipeline_run/i);
    expect(migration).toMatch(/new\.status = 'succeeded'/i);
  });

  it("authorizes one same-photo-set guided correction without spending again", () => {
    expect(migration).toMatch(/authorize_ai_item_guided_correction/i);
    expect(migration).toMatch(/regenerate_review_listing_with_credit/i);
    expect(migration).toMatch(/guided_correction_revision/i);
    expect(migration).toMatch(/guided_correction_completed_at/i);
    expect(migration).toMatch(/photo_set_fingerprint/i);
  });
});

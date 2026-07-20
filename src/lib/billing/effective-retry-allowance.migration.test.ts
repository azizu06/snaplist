import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260720013000_effective_retry_allowance_projection.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("effective retry allowance projection migration", () => {
  it("shares active-reclaim and capacity truth with canonical manual retry", () => {
    expect(migration).toMatch(
      /create or replace function private\.get_manual_retry_credit_projection/i,
    );
    expect(migration).toMatch(
      /state = 'restored'[\s\S]*retry_reservation_count > facts\.retry_restore_count[\s\S]*then 'reserved'/i,
    );
    expect(migration).toMatch(
      /candidate\.state = 'restored'[\s\S]*candidate\.retry_reservation_count[\s\S]*> candidate\.retry_restore_count/i,
    );
    expect(migration).toMatch(
      /create or replace function private\.reserve_ai_item_credit_for_manual_retry[\s\S]*private\.get_manual_retry_credit_projection/i,
    );
  });

  it("exposes only the authenticated provider-neutral read projection", () => {
    expect(migration).toMatch(
      /create or replace function public\.get_pipeline_run_retry_projection/i,
    );
    expect(migration).toMatch(
      /run\.status in \('failed', 'canceled'\)[\s\S]*projection\.can_reclaim as can_retry/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_pipeline_run_retry_projection\(uuid\)[\s\S]*to authenticated/i,
    );
    expect(migration).not.toMatch(/create or replace function public\.retry_pipeline_run/i);
    expect(migration).not.toMatch(/pgmq\./i);
  });
});

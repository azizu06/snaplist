import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717070000_credited_pipeline_retention.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("credited pipeline retention migration", () => {
  it("binds the photo-release exception to an exact private job created by this transaction", () => {
    expect(migration).toMatch(/new\.photos = '\{\}'::text\[\]/i);
    expect(migration).toMatch(/cleanup_job\.source_type = 'abandoned_item'/i);
    expect(migration).toMatch(/cleanup_job\.source_id = old\.id/i);
    expect(migration).toMatch(
      /cleanup_job\.photo_paths is not distinct from old\.photos/i,
    );
    expect(migration).toMatch(
      /cleanup_job\.xmin = pg_current_xact_id\(\)::xid/i,
    );
    expect(migration).not.toMatch(/current_setting|set_config/i);
  });

  it("locks every credited run identity before checking terminal credit state", () => {
    expect(migration).toMatch(
      /from public\.ai_item_credit_reservations reservation[\s\S]*order by reservation\.pipeline_run_id[\s\S]*for update of reservation/i,
    );
    expect(migration).toMatch(/reservation\.state = 'reserved'/i);
    expect(migration).toMatch(
      /reservation\.photo_set_fingerprint\s+is distinct from v_photo_set_fingerprint/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.retry_pipeline_run[\s\S]*pg_advisory_xact_lock\([\s\S]*snaplist:pipeline-retention[\s\S]*select \*[\s\S]*from public\.pipeline_runs[\s\S]*for update/i,
    );
  });

  it("does not expose generic credit or cleanup authority", () => {
    expect(migration).toMatch(/security definer[\s\S]*set search_path = ''/i);
    expect(migration).toMatch(
      /revoke all on function private\.enforce_credited_item_photo_set_immutable\(\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.ai_item_(?:credit_reservations|allowance_periods)/i,
    );
  });
});

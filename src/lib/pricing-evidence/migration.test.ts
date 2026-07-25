import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260719231000_pricing_evidence_snapshots.sql",
  ),
  "utf8",
);
const boundedMatchesMigrationPath = join(
  process.cwd(),
  "supabase/migrations/20260721210000_bounded_verified_sold_matches.sql",
);
const legacyRestoreMigrationPath = join(
  process.cwd(),
  "supabase/migrations/20260722035415_preserve_legacy_pricing_evidence_restore.sql",
);
const guidedAuthorityOrderMigrationPath = join(
  process.cwd(),
  "supabase/migrations/20260722040255_preserve_guided_correction_authority_order.sql",
);
const guidedAuthorityOrderMigration = existsSync(guidedAuthorityOrderMigrationPath)
  ? readFileSync(guidedAuthorityOrderMigrationPath, "utf8")
  : "";

describe("pricing-evidence snapshot migration", () => {
  /**
   * Discovery only. The evidence validators' behavior is proved against the
   * installed database in `supabase/tests/pricing_evidence_snapshots.test.sql`:
   * that the historical V1 validator still accepts sixty records and rejects a
   * sixty-first, that the current bounded-write validator accepts five verified
   * sold matches and rejects a sixth, that the snapshot table constraint keeps
   * the V1 validator, and that both completion RPCs apply the bounded-write one.
   * Re-asserting the SQL text here only coupled this suite to how those
   * functions are spelled.
   *
   * That pgTAP suite needs a running local stack and is not a CI step, same as
   * every other pgTAP contract in this repo, so this offline check is what still
   * fails fast when a version in the chain is renamed or dropped.
   */
  it("keeps every version of the evidence-bound migration chain discoverable", () => {
    for (const path of [
      boundedMatchesMigrationPath,
      legacyRestoreMigrationPath,
      guidedAuthorityOrderMigrationPath,
    ]) {
      expect(existsSync(path), `missing migration: ${path}`).toBe(true);
    }
  });

  it("preserves guided-correction authority precedence before bounded validation", () => {
    const unavailableCheck = guidedAuthorityOrderMigration.indexOf(
      "Guided correction capability is unavailable",
    );
    const bindingCheck = guidedAuthorityOrderMigration.indexOf(
      "Guided correction capability binding mismatch",
    );
    const boundedValidation = guidedAuthorityOrderMigration.indexOf(
      "pricing_evidence_rows_current_write",
    );
    const privateDelegate = guidedAuthorityOrderMigration.indexOf(
      "complete_guided_review_correction_legacy_evidence_v1",
    );

    expect(unavailableCheck).toBeGreaterThan(-1);
    expect(bindingCheck).toBeGreaterThan(unavailableCheck);
    expect(boundedValidation).toBeGreaterThan(bindingCheck);
    expect(privateDelegate).toBeGreaterThan(boundedValidation);
    expect(guidedAuthorityOrderMigration).not.toMatch(/for update/i);
  });

  it("creates one run-bound tenant row with immutable authenticated access", () => {
    expect(migration).toMatch(/create table public\.pricing_evidence_snapshots/i);
    expect(migration).toMatch(/run_id uuid primary key/i);
    expect(migration).toMatch(/foreign key \(pipeline_run_id, item_id, user_id\)[\s\S]*pipeline_runs/i);
    expect(migration).toMatch(/run_kind = 'review-correction'/i);
    expect(migration).toMatch(/create table private\.guided_correction_completion_capabilities/i);
    expect(migration).toMatch(/create or replace function public\.complete_guided_review_correction/i);
    expect(migration).toMatch(/foreign key \(listing_id, item_id, user_id\)[\s\S]*listings/i);
    expect(migration).not.toMatch(/foreign key \(listing_id, run_id, item_id, user_id\)/i);
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/grant select[\s\S]*to authenticated/i);
    expect(migration).not.toMatch(/grant (?:insert|update|delete)[\s\S]*to authenticated/i);
    expect(migration).toMatch(/pricing_evidence_snapshots_select_own[\s\S]*clerk_user_id/i);
    expect(migration).toMatch(/prevent_pricing_evidence_snapshot_update/i);
  });

  it("leaves pricing semantics to the strict reader and enforces coarse SQL bounds", () => {
    // The record-count bound is proved behaviorally by pgTAP; the byte bound is
    // not reachable from that suite, so it stays asserted here.
    expect(migration).toMatch(/octet_length\(p_evidence::text\) > 131072/i);
    expect(migration).toMatch(/evidenceAsOf/i);
    expect(migration).toMatch(/not \(price_result \? 'evidence'\)/i);
    expect(migration).not.toMatch(/\^https\?:\/\//i);
    expect(migration).not.toMatch(/displayed-sold-price/i);
    expect(migration).not.toMatch(/sold-comparable/i);
    expect(migration).not.toMatch(
      /#>> '\{item,title\}'[\s\S]{0,300}btrim\(/i,
    );
    expect(migration).not.toMatch(
      /#>> '\{item,condition\}'[\s\S]{0,180}btrim\(/i,
    );
  });

  it("revokes raw authenticated writers and grants only the bound completion split", () => {
    expect(migration).toMatch(/revoke execute on function public\.regenerate_review_listing\(/i);
    expect(migration).toMatch(/drop function if exists public\.authorize_ai_item_guided_correction\(uuid, uuid\)/i);
    expect(migration).toMatch(/grant execute on function public\.authorize_ai_item_guided_correction\([\s\S]*to authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.complete_guided_review_correction\(text, jsonb\)[\s\S]*to service_role/i);
    expect(migration).not.toMatch(/grant execute on function public\.complete_guided_review_correction\(text, jsonb\)[\s\S]*to authenticated/i);
  });

  it("persists the snapshot inside the lease-fenced atomic completion RPC", () => {
    expect(migration).toMatch(/create or replace function public\.complete_pipeline_run/i);
    expect(migration).toMatch(/p_persistence->'pricing_snapshot'/i);
    expect(migration).toMatch(/insert into public\.pricing_evidence_snapshots/i);
    expect(migration).toMatch(/v_prediction_id/i);
    expect(migration).toMatch(/v_listing_id/i);
    expect(migration).toMatch(/status = 'succeeded'/i);
  });

  it("uses the database clock when the first priced checkpoint becomes durable", () => {
    expect(migration).toMatch(
      /drop function if exists public\.checkpoint_pipeline_run\(uuid, uuid, text, jsonb, integer\)/i,
    );
    expect(migration).toMatch(
      /create function public\.checkpoint_pipeline_run[\s\S]+returns jsonb/i,
    );
    expect(migration).toMatch(
      /not \(checkpoint \? 'priced'\)[\s\S]+jsonb_set\([\s\S]+\{priced,evidenceAsOf\}[\s\S]+to_jsonb\(v_checkpointed_at\)/i,
    );
    expect(migration).toMatch(/v_checkpointed_at timestamptz := statement_timestamp\(\)/i);
    expect(migration).toMatch(/returning checkpoint into v_checkpoint/i);
  });

  it("rejects snapshot confidence that diverges from the canonical prediction", () => {
    expect(
      [
        ...migration.matchAll(
          /jsonb_typeof\(v_snapshot #> '\{price_result,confidence\}'\)/gi,
        ),
      ],
    ).toHaveLength(2);
    expect(migration).toMatch(
      /jsonb_typeof\(v_prediction->'confidence'\)/i,
    );
    expect(migration).toMatch(
      /jsonb_typeof\(p_persistence #> '\{prediction,confidence\}'\)/i,
    );
    expect(migration).toMatch(
      /v_snapshot #> '\{price_result,confidence\}'[\s\S]{0,160}v_prediction->'confidence'/i,
    );
    expect(migration).toMatch(
      /v_snapshot #> '\{price_result,confidence\}'[\s\S]{0,180}p_persistence #> '\{prediction,confidence\}'/i,
    );
  });
});

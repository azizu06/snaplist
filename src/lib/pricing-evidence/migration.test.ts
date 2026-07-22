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
const boundedMatchesMigration = existsSync(boundedMatchesMigrationPath)
  ? readFileSync(boundedMatchesMigrationPath, "utf8")
  : "";

describe("pricing-evidence snapshot migration", () => {
  it("hard-bounds new persisted verified sold matches at five", () => {
    expect(boundedMatchesMigration).toMatch(
      /create or replace function private\.pricing_evidence_rows_coarse\(p_evidence jsonb\)[\s\S]*jsonb_array_length\(p_evidence\) > 5/i,
    );
    expect(boundedMatchesMigration).toMatch(
      /revoke all on function private\.pricing_evidence_rows_coarse\(jsonb\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
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
    expect(migration).toMatch(/jsonb_array_length\(p_evidence\) > 60/i);
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

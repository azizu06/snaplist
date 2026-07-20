import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260719231000_pricing_evidence_snapshots.sql",
  ),
  "utf8",
);

describe("pricing-evidence snapshot migration", () => {
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
});

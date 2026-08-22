import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline companion for the #820 item 4 fix: a redelivered post-completion
 * report was accepted unconditionally instead of being compared against what
 * was actually recorded, unlike the running-path writer's own replay check.
 * No live DB is required -- see post-completion-migration.test.ts for the
 * established pattern this extends.
 */
const MIGRATION_PATH =
  "supabase/migrations/20260821221000_post_completion_provider_usage_replay_fence.sql";

const migration = readFileSync(
  new URL(`../../../${MIGRATION_PATH}`, import.meta.url),
  "utf8",
);

const WRITER_SIGNATURE =
  "create or replace function public.record_guided_correction_provider_usage";

/** The writer function's own body, not the whole migration (#820 item 2 lesson applied here too). */
function writerFunctionBody(): string {
  const start = migration.indexOf(WRITER_SIGNATURE);
  const nextFunctionStart = migration.indexOf(
    "create or replace function",
    start + WRITER_SIGNATURE.length,
  );
  return nextFunctionStart > -1
    ? migration.slice(start, nextFunctionStart)
    : migration.slice(start);
}

describe("post-completion provider usage replay fence migration", () => {
  it("stores the exact payload a completion recorded, alongside the existing timestamp", () => {
    expect(migration).toMatch(
      /alter table private\.guided_correction_completion_capabilities\s+add column provider_usage_payload jsonb/i,
    );
    expect(migration).toMatch(
      /\(provider_usage_recorded_at is null\) = \(provider_usage_payload is null\)/,
    );
  });

  it("compares a replay against the recorded payload instead of assuming success", () => {
    const body = writerFunctionBody();
    const fenceStart = body.indexOf(
      "if v_cap.provider_usage_recorded_at is not null then",
    );
    const conflictRaise = body.indexOf(
      "message = 'Provider usage conflicts with the durable run receipt';",
      fenceStart,
    );
    const fenceEnd = body.indexOf("end if;", conflictRaise);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(conflictRaise).toBeGreaterThan(fenceStart);
    const fence = body.slice(fenceStart, fenceEnd);

    expect(fence).toContain("if p_usage = v_cap.provider_usage_payload then");
    expect(fence).toContain("return true;");
    expect(fence).toMatch(
      /raise exception using\s+errcode = '55000',\s+message = 'Provider usage conflicts with the durable run receipt';/,
    );
  });

  it("matches the running path's own conflict errcode and message for the same failure mode", () => {
    // record_pipeline_run_provider_usage (patched by 20260811120000 /
    // 20260811123000) raises this exact pair on a divergent replay; the
    // post-completion writer now raises the same one instead of a
    // differently-worded conflict for an identical situation.
    expect(migration).toMatch(
      /errcode = '55000',\s+message = 'Provider usage conflicts with the durable run receipt';/,
    );
  });

  it("persists the recorded payload only on the success path that actually wrote the merge", () => {
    const body = writerFunctionBody();
    expect(body).toMatch(
      /provider_usage_recorded_at = v_now,\s+provider_usage_payload = p_usage/,
    );
  });

  it("is anchored: a writer stripped of its own search_path clause fails the property above", () => {
    // Positive control, same reasoning as #820 item 2.
    expect(writerFunctionBody()).toMatch(
      /security definer[\s\S]*?set search_path = ''/i,
    );
    const mutated = writerFunctionBody().replace(
      /set search_path = ''/,
      "-- search_path clause removed for the control",
    );
    expect(mutated).not.toMatch(/security definer[\s\S]*?set search_path = ''/i);
  });

  it("exposes the replacement writer only to the worker identity", () => {
    expect(migration).toMatch(
      /revoke all on function public\.record_guided_correction_provider_usage\(text, jsonb\)\s+from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_guided_correction_provider_usage\(text, jsonb\)\s+to service_role/i,
    );
  });

  it("leaves the lease-fenced running-path writer, tenancy fence, and overflow guard untouched", () => {
    expect(migration).not.toMatch(
      /create or replace function public\.record_pipeline_run_provider_usage/i,
    );
    expect(migration).not.toMatch(/lease_token/i);
    expect(migration).toMatch(/stored\.user_id = v_cap\.user_id/);
    expect(migration).toMatch(/stored\.item_id = v_cap\.item_id/);
    expect(migration).toMatch(/jsonb_array_length\(v_merged_models\) > 64/);
    expect(migration).toMatch(/jsonb_array_length\(v_merged_sold_comps\) > 16/);
  });
});

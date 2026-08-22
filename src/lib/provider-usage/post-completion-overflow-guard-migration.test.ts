import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline companion for the #820 item 3 fix: the post-completion writer's
 * overflow guard originally named every persisted numeric bound except the
 * four bigint token columns, and the merge functions had no guard against
 * exceeding the table's own 64/16 entry-count CHECK constraints. No live DB
 * is required — see post-completion-migration.test.ts for the established
 * pattern this extends.
 */
const MIGRATION_PATH =
  "supabase/migrations/20260821220000_post_completion_provider_usage_overflow_guard.sql";

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

describe("post-completion provider usage overflow guard migration", () => {
  it("replaces the same writer function the original #724 migration installed", () => {
    expect(migration).toMatch(new RegExp(WRITER_SIGNATURE, "i"));
  });

  it("bounds every bigint token column the run total can grow, not only the integer columns", () => {
    const body = writerFunctionBody();
    const bigintMax = "9223372036854775807";
    for (const column of [
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_tokens",
    ]) {
      expect(body).toMatch(
        new RegExp(`v_stored\\.${column} \\+ v_${column} > ${bigintMax}`),
      );
    }
  });

  it("still bounds every integer column the original guard named", () => {
    const body = writerFunctionBody();
    const int32Max = "2147483647";
    for (const expr of [
      `v_stored.model_calls + v_model_calls > ${int32Max}`,
      `v_stored.sold_comp_attempts + v_sold_comp_attempts > ${int32Max}`,
      `v_stored.sold_comp_results + v_sold_comp_results > ${int32Max}`,
      `v_stored.correction_count + 1 > ${int32Max}`,
    ]) {
      expect(body).toContain(expr);
    }
  });

  it("guards the merged entry counts against the table's own 64/16 CHECK bounds before writing", () => {
    const body = writerFunctionBody();
    // Computed once, before the guard, and reused in the update -- never
    // merged twice (#820 item 3).
    expect(body).toMatch(
      /v_merged_models := private\.provider_usage_merge_models\(v_stored\.models, v_models\)/,
    );
    expect(body).toMatch(
      /v_merged_sold_comps := private\.provider_usage_merge_sold_comps\(\s*v_stored\.sold_comps, v_sold_comps\s*\)/,
    );
    expect(body).toContain("jsonb_array_length(v_merged_models) > 64");
    expect(body).toContain("jsonb_array_length(v_merged_sold_comps) > 16");
    // The update writes the SAME merged values the guard just checked.
    expect(body).toMatch(/models = v_merged_models/);
    expect(body).toMatch(/sold_comps = v_merged_sold_comps/);
  });

  it("still raises the deliberate 22023 for every bound, not an opaque table CHECK violation", () => {
    const body = writerFunctionBody();
    const guardStart = body.indexOf("if v_stored.model_calls");
    const guardEnd = body.indexOf("end if;", guardStart);
    expect(guardStart).toBeGreaterThan(-1);
    const guard = body.slice(guardStart, guardEnd);
    expect(guard).toContain("jsonb_array_length(v_merged_sold_comps) > 16");
    expect(guard).toMatch(
      /raise exception using\s+errcode = '22023',\s+message = 'Invalid provider usage record';/,
    );
  });

  it("exposes the replacement writer only to the worker identity", () => {
    expect(writerFunctionBody()).toMatch(
      /security definer[\s\S]*?set search_path = ''/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_guided_correction_provider_usage\(text, jsonb\)\s+from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_guided_correction_provider_usage\(text, jsonb\)\s+to service_role/i,
    );
  });

  it("is anchored: a writer stripped of its own search_path clause fails the property above", () => {
    // Positive control, same reasoning as #820 item 2.
    const mutated = writerFunctionBody().replace(
      /set search_path = ''/,
      "-- search_path clause removed for the control",
    );
    expect(mutated).not.toMatch(/security definer[\s\S]*?set search_path = ''/i);
  });

  it("leaves the lease-fenced running-path writer and the replay/tenancy fences untouched", () => {
    expect(migration).not.toMatch(
      /create or replace function public\.record_pipeline_run_provider_usage/i,
    );
    expect(migration).not.toMatch(/lease_token/i);
    expect(migration).toMatch(/v_cap\.consumed_at is null/);
    expect(migration).toMatch(/stored\.user_id = v_cap\.user_id/);
    expect(migration).toMatch(/stored\.item_id = v_cap\.item_id/);
  });
});

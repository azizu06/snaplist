import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20260721180000_mobile_item_submission_five_photos.sql";

function definition(source: string, qualifiedName: string): string {
  const start = source.indexOf(`create or replace function ${qualifiedName}(`);
  if (start < 0) throw new Error(`Missing function ${qualifiedName}`);
  const end = source.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`Unterminated function ${qualifiedName}`);
  return source.slice(start, end + "\n$$;".length);
}

function replaceExactly(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
}

describe("five-photo mobile submission migration", () => {
  it("changes only the approved bounds inside copied fixed-function bodies", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const staging = readFileSync(
      "supabase/migrations/20260715035314_durable_upload_staging.sql",
      "utf8",
    );
    const credit = readFileSync(
      "supabase/migrations/20260720003000_manual_retry_credit_reconciliation.sql",
      "utf8",
    );
    const mobile = readFileSync(
      "supabase/migrations/20260720210000_mobile_item_submission.sql",
      "utf8",
    );
    const guest = readFileSync(
      "supabase/migrations/20260717120000_guest_claim_or_expire.sql",
      "utf8",
    );

    const replayExpected = replaceExactly(
      definition(staging, "public.find_pipeline_batch_replay"),
      "      or (v_entry->>'photo_count')::integer not between 1 and 4\n      or jsonb_typeof(v_entry->'cost_basis') not in ('number', 'null') then",
      "      or (v_entry->>'photo_count')::integer not between 1 and 5\n      or (\n        v_entry->>'source' = 'batch'\n        and (v_entry->>'photo_count')::integer > 4\n      )\n      or jsonb_typeof(v_entry->'cost_basis') not in ('number', 'null') then",
    );
    expect(definition(migration, "public.find_pipeline_batch_replay")).toBe(
      replayExpected,
    );

    const stagingExpected = replaceExactly(
      definition(staging, "public.stage_pipeline_batch"),
      "      or jsonb_array_length(v_entry->'photo_paths') not between 1 and 4\n      or jsonb_typeof(v_entry->'cost_basis') not in ('number', 'null') then",
      "      or jsonb_array_length(v_entry->'photo_paths') not between 1 and 5\n      or (\n        v_source = 'batch'\n        and jsonb_array_length(v_entry->'photo_paths') > 4\n      )\n      or jsonb_typeof(v_entry->'cost_basis') not in ('number', 'null') then",
    );
    expect(definition(migration, "public.stage_pipeline_batch")).toBe(
      stagingExpected,
    );

    expect(
      definition(migration, "private.reserve_ai_item_credit_for_pipeline_run"),
    ).toBe(
      replaceExactly(
        definition(credit, "private.reserve_ai_item_credit_for_pipeline_run"),
        "cardinality(v_photo_paths) not between 1 and 4",
        "cardinality(v_photo_paths) not between 1 and 5",
      ),
    );

    for (const functionName of [
      "public.begin_mobile_item_submission",
      "public.commit_mobile_item_submission",
    ]) {
      expect(definition(migration, functionName)).toBe(
        replaceExactly(
          definition(mobile, functionName),
          "jsonb_array_length(p_photo_receipts) not between 1 and 4",
          "jsonb_array_length(p_photo_receipts) not between 1 and 5",
        ),
      );
    }

    expect(
      definition(migration, "private.queue_guest_recovery_storage_cleanup"),
    ).toBe(
      replaceExactly(
        definition(guest, "private.queue_guest_recovery_storage_cleanup"),
        "cardinality(v_paths) not between 1 and 4",
        "cardinality(v_paths) not between 1 and 5",
      ),
    );

    expect(
      definition(migration, "private.queue_guest_claim_copy_cleanup"),
    ).toBe(
      definition(guest, "private.queue_guest_claim_copy_cleanup")
        .replaceAll("not between 1 and 4", "not between 1 and 5"),
    );

    expect(definition(migration, "public.register_guest_draft_recovery")).toBe(
      replaceExactly(
        definition(guest, "public.register_guest_draft_recovery"),
        "jsonb_array_length(p_storage_manifest) not between 1 and 4",
        "jsonb_array_length(p_storage_manifest) not between 1 and 5",
      ),
    );
  });

  it("widens only direct single-item and guest constraints to five", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /mobile_item_submissions_photo_receipts_check[\s\S]*jsonb_array_length\(photo_receipts\) between 1 and 5/i,
    );
    expect(migration).toMatch(
      /pipeline_runs_capture_input_check[\s\S]*capture_input->>'source' = 'single'[\s\S]*capture_input->>'photo_count' = '5'/i,
    );
    expect(migration).toMatch(
      /guest_draft_recoveries_object_count_check[\s\S]*storage_object_count between 1 and 5/i,
    );
    expect(migration).not.toMatch(/between 1 and 6|maxItems[^\n]*6/i);
  });
});

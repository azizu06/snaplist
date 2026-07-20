import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260720210000_mobile_item_submission.sql"),
  "utf8",
);

describe("mobile item submission migration", () => {
  it("binds one ordered request fingerprint to one atomic #159/#333 run receipt", () => {
    expect(migration).toMatch(/create table private\.mobile_item_submissions/i);
    expect(migration).toMatch(/primary key \(user_id, idempotency_key\)/i);
    expect(migration).toMatch(/request_fingerprint[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
    expect(migration).toMatch(/state text not null default 'uploading'/i);
    expect(migration).toMatch(/create or replace function public\.begin_mobile_item_submission/i);
    expect(migration).toMatch(
      /begin_mobile_item_submission[\s\S]*record_pipeline_staging_cleanup_intent[\s\S]*insert into private\.mobile_item_submissions/i,
    );
    expect(migration).toMatch(/pg_advisory_xact_lock[\s\S]*mobile-item-submission/i);
    expect(migration).toMatch(
      /public\.stage_pipeline_batch\([\s\S]*v_photo_identities/i,
    );
    expect(migration).toMatch(/content_sha256_set_v1/i);
    expect(migration).toMatch(/private\.pipeline_staging_cleanup_intents/i);
  });

  it("exposes only fixed service-role RPCs and no generic private table access", () => {
    expect(migration).toMatch(
      /revoke all on table private\.mobile_item_submissions[\s\S]*service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.find_mobile_item_submission[\s\S]*to service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.begin_mobile_item_submission[\s\S]*to service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.commit_mobile_item_submission[\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*private\.mobile_item_submissions/i,
    );
  });

  it("renews exact pending cleanup protection before replay can upload", () => {
    expect(migration).toMatch(
      /if v_submission\.state = 'uploading' then[\s\S]*record_pipeline_staging_cleanup_intent[\s\S]*update private\.pipeline_staging_cleanup_intents[\s\S]*cleanup_after[\s\S]*interval '24 hours'[\s\S]*return false/i,
    );
  });
});

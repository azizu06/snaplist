import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717120000_guest_claim_or_expire.sql",
    import.meta.url,
  ),
  "utf8",
);
const quiescenceMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260719183500_guest_claim_copy_cleanup_quiescence.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(name: string, source = migration): string {
  const match = source.match(new RegExp(
    `create or replace function ${name.replaceAll(".", "\\.")}[\\s\\S]+?as \\$\\$([\\s\\S]+?)\\$\\$;`,
    "i",
  ));
  if (!match?.[1]) throw new Error(`Missing SQL function ${name}`);
  return match[1];
}

describe("guest claim-or-expire database contract", () => {
  it("anchors an immutable 24-hour deadline to server-recorded durable completion", () => {
    expect(migration).toMatch(/create table private\.guest_draft_recoveries/i);
    expect(migration).toMatch(/usable_draft_at timestamptz not null/i);
    expect(migration).toMatch(/expires_at timestamptz not null/i);
    expect(migration).toMatch(/v_run\.completed_at \+ interval '24 hours'/i);
    expect(migration).toMatch(/expires_at = usable_draft_at \+ interval '24 hours'/i);
    expect(migration).toMatch(/statement_timestamp\(\) >= v_recovery\.expires_at/i);
    expect(migration).not.toMatch(/p_(?:usable_draft_at|expires_at|ttl)/i);
  });

  it("stores only encrypted recovery material and a bounded private-Storage manifest", () => {
    expect(migration).toMatch(/encrypted_artifact jsonb/i);
    expect(migration).toMatch(/aes-256-gcm/i);
    expect(migration).toMatch(/keyEnvelope/i);
    expect(migration).toMatch(/storage_manifest jsonb/i);
    expect(migration).toMatch(
      /jsonb_array_length\(p_storage_manifest\)[\s\S]+not between 1 and 4/i,
    );
    expect(migration).toMatch(/sourcePath/i);
    expect(migration).toMatch(/sha256/i);
    expect(migration).toMatch(/byteLength/i);
    expect(migration).toMatch(
      /p_target_user_id \|\| '\/guest-claims\/' \|\| p_recovery_id::text[\s\S]+p_claim_lease_token::text/i,
    );
    expect(migration).not.toMatch(/signed_url|signedUrl/i);
  });

  it("rejects malformed or cryptographically invalid AES-GCM envelopes", () => {
    const validator = migration.match(
      /create or replace function private\.valid_guest_base64[\s\S]+?\$\$;/i,
    )?.[0];
    expect(validator).toBeDefined();
    expect(validator).not.toMatch(/\nstrict\n/i);
    expect(migration).toMatch(/create or replace function private\.valid_guest_base64/i);
    expect(migration).toMatch(/private\.valid_guest_base64\([^;]+p_exact_bytes\s*=>\s*12/i);
    expect(migration).toMatch(/private\.valid_guest_base64\([^;]+p_exact_bytes\s*=>\s*16/i);
    expect(migration).toMatch(/private\.valid_guest_base64\([^;]+p_min_bytes\s*=>\s*1/i);
  });

  it("uses a literal-safe guest Storage prefix instead of SQL LIKE wildcards", () => {
    const registration = functionBody("public.register_guest_draft_recovery");
    expect(registration).not.toMatch(/like\s+p_guest_user_id/i);
    expect(registration).toMatch(/left\([^;]+char_length\(p_guest_user_id\)\s*\+\s*1/i);
  });

  it("fences one claim or expiry outcome and makes terminal retries stable", () => {
    expect(migration).toMatch(/for update(?: of recovery)?/i);
    expect(migration).toMatch(/pg_advisory_xact_lock/i);
    expect(migration).toMatch(/state in \('claimable', 'copying', 'claimed', 'expired'\)/i);
    expect(migration).toMatch(/create or replace function public\.begin_guest_draft_claim/i);
    expect(migration).toMatch(/create or replace function public\.complete_guest_draft_claim/i);
    expect(migration).toMatch(/create or replace function public\.expire_guest_draft_recoveries/i);
    expect(migration).toMatch(/'purgeLocalRecovery', true/i);
    expect(migration).toMatch(/'outcome', p_recovery\.state/i);
    expect(migration).toMatch(/state in \('claimed', 'expired'\)/i);
  });

  it.each([
    "public.begin_guest_draft_claim",
    "public.complete_guest_draft_claim",
    "public.release_guest_draft_claim",
  ])("fences terminal %s outcomes to the authenticated target", (name) => {
    expect(functionBody(name)).toMatch(
      /private\.guest_terminal_outcome_for_target\(\s*v_recovery,\s*p_target_user_id\s*\)/i,
    );
  });

  it("transfers the same settled reservation and domain graph under deferred constraints", () => {
    expect(migration).toMatch(/set constraints[\s\S]+deferred/i);
    expect(migration).toMatch(/update public\.ai_item_credit_reservations/i);
    expect(migration).toMatch(/where reservation\.id = v_recovery\.reservation_id[\s\S]+state = 'settled'/i);
    expect(migration).toMatch(/update public\.items/i);
    expect(migration).toMatch(/update public\.listings/i);
    expect(migration).toMatch(/update public\.prediction_logs/i);
    expect(migration).toMatch(/update public\.pipeline_runs/i);
    expect(migration).toMatch(/update public\.notifications/i);
    expect(migration).toMatch(/update private\.pipeline_run_usage_reservations/i);
    expect(migration).not.toMatch(/settle_ai_item_credit\s*\(/i);
    expect(migration).not.toMatch(/restore_ai_item_credit\s*\(/i);
  });

  it("validates and transfers the current corrected prediction paired to the draft", () => {
    const completion = functionBody("public.complete_guest_draft_claim");
    expect(completion).toMatch(/prediction\.run_id\s*=\s*draft\.run_id/i);
    expect(completion).toMatch(/jsonb_typeof\(item\.attributes\)\s*=\s*'object'/i);
    expect(completion).toMatch(/item\.attributes\s*<>\s*'\{\}'::jsonb/i);
    expect(completion).toMatch(/jsonb_typeof\(item\.identification\)\s*=\s*'object'/i);
    expect(completion).toMatch(/prediction\.price\s*>\s*0/i);
    expect(completion).toMatch(/jsonb_typeof\(prediction\.price_range\)\s*=\s*'object'/i);
    expect(completion).toMatch(/prediction\.confidence\s+between\s+0\s+and\s+1/i);
    expect(completion).toMatch(/coalesce\(btrim\(prediction\.tier_fired\),\s*''\)\s*<>\s*''/i);
    expect(completion).toMatch(/jsonb_typeof\(prediction\.sources\)\s*=\s*'array'/i);
    expect(completion).toMatch(/jsonb_array_length\(prediction\.sources\)\s*>\s*0/i);
    expect(completion).toMatch(/prediction\.tier_fired\s*=\s*'llm-only'/i);
    expect(completion).toMatch(/draft\.platform\s*=\s*'ebay'/i);
    expect(completion).toMatch(/coalesce\(btrim\(draft\.title\),\s*''\)\s*<>\s*''/i);
    expect(completion).toMatch(/char_length\(draft\.title\)\s*<=\s*80/i);
    expect(completion).toMatch(/coalesce\(btrim\(draft\.description\),\s*''\)\s*<>\s*''/i);
    expect(completion).toMatch(
      /update public\.prediction_logs prediction[\s\S]+prediction\.item_id\s*=\s*v_recovery\.item_id[\s\S]+prediction\.user_id\s*=\s*v_recovery\.guest_user_id/i,
    );
  });

  it("reuses the bounded cleanup queue without exposing broad tenant authority", () => {
    expect(migration).toMatch(
      /source_type in \(\s*'staging', 'abandoned_item', 'guest_recovery', 'guest_claim_copy'\s*\)/i,
    );
    expect(migration).toMatch(/insert into private\.pipeline_storage_cleanup_jobs/i);
    expect(migration).toMatch(/create or replace function private\.queue_guest_claim_copy_cleanup/i);
    expect(migration).toMatch(/storage_object_count\s+integer\s+not null/i);
    expect(migration).toMatch(/claimed_lease_token\s+uuid/i);
    expect(migration).toMatch(/guest_copy_writer_quiesced\s+boolean\s+not null/i);
    expect(migration).toMatch(/resweep_requested\s+boolean\s+not null/i);
    expect(migration).toMatch(/guest_copy_final_sweep_armed\s+boolean\s+not null/i);
    expect(functionBody("public.queue_guest_claim_copy_cleanup", quiescenceMigration)).toMatch(
      /claim_idempotency_user_id\s*=\s*p_target_user_id[\s\S]+claim_idempotency_key\s*=\s*p_idempotency_key[\s\S]+private\.queue_guest_claim_copy_cleanup\([\s\S]+p_target_user_id[\s\S]+p_claim_lease_token/i,
    );
    expect(functionBody("private.queue_guest_claim_copy_cleanup")).toMatch(
      /state\s*=\s*'claimed'[\s\S]+claimed_lease_token\s*=\s*p_claim_lease_token[\s\S]+return false/i,
    );
    expect(functionBody("private.queue_guest_claim_copy_cleanup")).toMatch(
      /cleanup_job\.state\s*=\s*'dead'[\s\S]+not cleanup_job\.guest_copy_final_sweep_armed[\s\S]+then 'pending'[\s\S]+max_attempts\s*-\s*1/i,
    );
    expect(functionBody("public.complete_pipeline_storage_cleanup")).toMatch(
      /guest_claim_copy[\s\S]+resweep_requested[\s\S]+guest_copy_final_sweep_armed\s*=\s*true[\s\S]+not v_job\.guest_copy_writer_quiesced[\s\S]+attempt_count\s*>=\s*v_job\.max_attempts/i,
    );
    expect(migration).not.toMatch(/v_paths\s*:=\s*v_paths\s*\|\|/i);
    expect(migration).toMatch(
      /p_claim_lease_token::text\s*\|\|\s*'\/'\s*\|\|\s*entry\.ordinality::text/i,
    );
    expect(migration).toMatch(/grant execute on function public\.(?:register|begin|complete|release|resolve|expire|queue)_guest[^;]+to service_role/gi);
    expect(migration).not.toMatch(/grant execute on function public\.(?:register|begin|complete|release|resolve|expire|queue)_guest[^;]+to (?:anon|authenticated)/i);
    expect(migration).toMatch(/revoke all on table private\.guest_draft_recoveries/i);
  });

  it("upgrades databases that already applied the frozen parent migration", () => {
    expect(quiescenceMigration).toMatch(
      /drop function public\.queue_guest_claim_copy_cleanup\(uuid, text, text, uuid\)/i,
    );
    expect(quiescenceMigration).toMatch(
      /create or replace function public\.queue_guest_claim_copy_cleanup\([\s\S]+p_idempotency_key uuid[\s\S]+p_claim_lease_token uuid/i,
    );
    expect(quiescenceMigration).toMatch(
      /grant execute on function public\.queue_guest_claim_copy_cleanup\(\s*uuid, text, text, uuid, uuid\s*\) to service_role/i,
    );
  });
});

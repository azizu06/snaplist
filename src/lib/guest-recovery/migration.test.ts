import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717120000_guest_claim_or_expire.sql",
    import.meta.url,
  ),
  "utf8",
);

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
      /p_target_user_id \|\| '\/guest-claims\/' \|\| p_recovery_id::text/i,
    );
    expect(migration).not.toMatch(/signed_url|signedUrl/i);
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

  it("reuses the bounded cleanup queue without exposing broad tenant authority", () => {
    expect(migration).toMatch(/source_type in \('staging', 'abandoned_item', 'guest_recovery'\)/i);
    expect(migration).toMatch(/insert into private\.pipeline_storage_cleanup_jobs/i);
    expect(migration).toMatch(/grant execute on function public\.(?:register|begin|complete|release|resolve|expire)_guest[^;]+to service_role/gi);
    expect(migration).not.toMatch(/grant execute on function public\.(?:register|begin|complete|release|resolve|expire)_guest[^;]+to (?:anon|authenticated)/i);
    expect(migration).toMatch(/revoke all on table private\.guest_draft_recoveries/i);
  });
});

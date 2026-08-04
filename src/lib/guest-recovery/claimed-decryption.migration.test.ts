import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260804040000_claimed_guest_recovery_plaintext.sql",
  "utf8",
);

describe("claimed guest recovery plaintext transition", () => {
  it("atomically transfers plaintext receipts and purges every guest envelope carrier", () => {
    expect(migration).toMatch(
      /create or replace function public\.complete_guest_draft_claim_with_plaintext/i,
    );
    expect(migration).toMatch(
      /sourceSha256[\s\S]*sourceByteLength[\s\S]*plaintextSha256[\s\S]*plaintextByteLength[\s\S]*mediaType/i,
    );
    expect(migration).toMatch(
      /delete from public\.pricing_evidence_snapshots[\s\S]*insert into public\.pricing_evidence_snapshots[\s\S]*p_target_user_id/i,
    );
    expect(migration).not.toMatch(
      /create or replace function private\.prevent_pricing_evidence_snapshot_update/i,
    );
    expect(migration).toMatch(
      /sourceSha256', 'sourceByteLength'[\s\S]*set encrypted_artifact = null,[\s\S]*storage_manifest = null,[\s\S]*claimed_storage_manifest = v_plaintext_receipts/i,
    );
    expect(migration).not.toMatch(/'accountRecovery'/i);
    expect(migration).toMatch(
      /revoke all on function public\.complete_guest_draft_claim\([\s\S]*from service_role/i,
    );
    expect(migration).toMatch(
      /complete_guest_draft_claim_with_plaintext\([\s\S]*public\.clerk_user_id\(\)[\s\S]*p_target_user_id[\s\S]*grant execute[\s\S]*to authenticated/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.complete_guest_draft_claim_with_plaintext\([\s\S]*to service_role/i,
    );
    expect(migration).toMatch(
      /add column claim_completion_token_hash[\s\S]*begin_guest_draft_claim_with_plaintext[\s\S]*p_completion_token_hash/i,
    );
    expect(migration).toMatch(
      /claim_completion_token_hash[\s\S]*sha256\(convert_to\(p_completion_token[\s\S]*Guest claim completion capability is invalid/i,
    );
    expect(migration).toMatch(
      /claim_lease_token is distinct from old\.claim_lease_token[\s\S]*claim_completion_token_hash := null/i,
    );
  });
});

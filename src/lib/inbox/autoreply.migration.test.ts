import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260714170000_grounded_message_autoreply.sql",
  ),
  "utf8",
);

describe("grounded message autoreply migration", () => {
  it("adds one default-off tenant preference and a per-version unique audit record", () => {
    expect(migration).toMatch(
      /auto_reply_enabled\s+boolean\s+not\s+null\s+default\s+false/i,
    );
    expect(migration).toMatch(/create table[^;]+message_policy_decisions/i);
    expect(migration).toMatch(
      /unique\s*\(\s*user_id\s*,\s*message_id\s*,\s*policy_version\s*\)/i,
    );
  });

  it("keeps audit rows tenant-readable and server-write-only", () => {
    expect(migration).toMatch(
      /alter table public\.message_policy_decisions enable row level security/i,
    );
    expect(migration).toMatch(/message_policy_decisions_select_own/i);
    expect(migration).not.toMatch(/message_policy_decisions_(insert|update|delete)_own/i);
  });

  it("provides distinct authenticated and scheduler decision/read entry points", () => {
    expect(migration).toMatch(/record_ebay_message_policy_decision/i);
    expect(migration).toMatch(/record_scheduled_ebay_message_policy_decision/i);
    expect(migration).toMatch(/read_scheduled_ebay_message_policy/i);
    expect(migration).toMatch(/auth\.jwt\(\)->>'role'[\s\S]*service_role/i);
  });

  it("permits scheduler auto-send only through the existing durable canonical transport", () => {
    for (const operation of [
      "claim_canonical",
      "begin_provider_dispatch",
      "renew_provider_dispatch",
      "fail_canonical",
      "complete_canonical",
    ]) {
      expect(migration).toContain(`'${operation}'`);
    }
    expect(migration).toMatch(/auto_reply_enabled\s*=\s*true/i);
    expect(migration).toMatch(/message\.draft_reply\s*=\s*decision\.proposed_reply/i);
    expect(migration).toMatch(/decision\.outcome\s*=\s*'auto_send'/i);
    expect(migration).toMatch(/assert_current_automatic_message_delivery/i);
    expect(migration).toMatch(/listing\.updated_at\s*=\s*decision\.listing_updated_at/i);
    expect(migration).toMatch(/item\.updated_at\s*=\s*decision\.item_updated_at/i);
    expect(migration).toMatch(/dispatch_verified_at[\s\S]*interval '5 minutes'/i);
    expect(migration).toMatch(/question_verified_at[\s\S]*interval '5 minutes'/i);
    expect(migration).toMatch(/question_observed_at/i);
  });

  it("mirrors real transport truth into the audit record", () => {
    expect(migration).toMatch(/sync_message_policy_delivery/i);
    expect(migration).toMatch(/delivery_status/i);
    expect(migration).toMatch(/external_delivery_id/i);
    expect(migration).toMatch(/policy_delivery_actor/i);
    expect(migration).toMatch(/delivery_actor/i);
    expect(migration).toMatch(/delivery_status\s*=\s*'blocked'/i);
    expect(migration).toMatch(/policy_delivery_status\s*=\s*'blocked'/i);
  });

  it("atomically retires a question that eBay explicitly confirms was answered", () => {
    const blockFunction = migration.match(
      /create or replace function private\.block_ebay_message_policy_delivery_for_tenant[\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(blockFunction).toMatch(/p_reason\s*=\s*'question_answered'/i);
    expect(blockFunction).toMatch(
      /status\s*=\s*case[\s\S]*p_reason\s*=\s*'question_answered'[\s\S]*then\s*'externally_answered'/i,
    );
    expect(blockFunction).toMatch(
      /draft_reply\s*=\s*case[\s\S]*p_reason\s*=\s*'question_answered'[\s\S]*then\s*null/i,
    );
    expect(blockFunction).toMatch(
      /draft_model\s*=\s*case[\s\S]*p_reason\s*=\s*'question_answered'[\s\S]*then\s*null/i,
    );
  });
});

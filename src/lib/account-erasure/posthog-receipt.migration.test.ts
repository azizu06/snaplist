import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  "supabase/migrations/20260802170000_posthog_account_erasure_proof.sql",
);

describe("PostHog account-erasure receipt migration", () => {
  it("withholds terminal receipt status until the named PostHog proof is recorded", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const proofGuard = migration.indexOf(
      "if not coalesce(p_posthog_person_and_events_deletion_confirmed, false)",
    );
    const terminalWrite = migration.indexOf("set status = case");

    expect(migration).toContain("posthog_person_uuid uuid");
    expect(migration).toContain(
      "posthog_person_and_events_deletion_proved_at timestamptz",
    );
    expect(migration).toContain("record_account_erasure_posthog_person_uuid");
    expect(migration).toContain("if p_person_uuid is null then");
    expect(proofGuard).toBeGreaterThan(-1);
    expect(terminalWrite).toBeGreaterThan(proofGuard);
    expect(migration).toContain(
      "message = 'PostHog person and event deletion is not proved'",
    );
    expect(migration).toMatch(
      /posthog_person_uuid = null,[\s\S]*posthog_person_and_events_deletion_proved_at = statement_timestamp\(\)/,
    );
    expect(migration).not.toContain("SNAPLIST_POSTHOG_KEY");
  });
});

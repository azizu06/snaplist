import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  "supabase/migrations/20260728160000_authenticated_guest_submission_commit.sql",
);
const stagingMigrationPath = resolve(
  "supabase/migrations/20260715035314_durable_upload_staging.sql",
);
const fixturePath = resolve(
  "src/lib/mobile-item-submission/rls-test-fixture.ts",
);
const publicSelectorPath = resolve(
  "src/lib/mobile-item-submission/guest-first-run.rls.test.ts",
);

describe("authenticated guest denial cleanup fence migration", () => {
  it("retains the uploading generation until Storage cleanup resolves", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const denialStart = migration.indexOf("exception\n    when sqlstate 'P0001'");
    const committedTransition = migration.indexOf(
      "update private.mobile_item_submissions submission",
      denialStart,
    );
    const denialBlock = migration.slice(denialStart, committedTransition);

    expect(denialStart).toBeGreaterThan(-1);
    expect(committedTransition).toBeGreaterThan(denialStart);
    expect(denialBlock).toMatch(/denial_reason := case/i);
    expect(denialBlock).not.toMatch(
      /delete from private\.mobile_item_submissions/i,
    );
  });

  it("keeps cleanup resolution service-only so guests cannot bypass Storage deletion", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const resolution = migration.match(
      /create or replace function public\.resolve_pipeline_staging_cleanup_intent\([\s\S]*?\n\$\$;/i,
    )?.[0];

    expect(resolution).toBeDefined();
    expect(resolution).toMatch(/v_role <> 'service_role'[\s\S]*raise exception/i);
    expect(resolution).not.toMatch(/v_role = 'authenticated'/i);
    expect(resolution).not.toMatch(/assert_verified_guest_capability/i);
    expect(resolution).toMatch(
      /delete from private\.pipeline_staging_cleanup_intents/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.resolve_pipeline_staging_cleanup_intent\(uuid\)\s*to service_role;/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.resolve_pipeline_staging_cleanup_intent\(uuid\)[\s\S]*to service_role, authenticated/i,
    );
  });

  it("retires the denied ledger only after generation-authorized Storage deletion completes", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const completion = migration.match(
      /create or replace function public\.complete_pipeline_storage_cleanup\([\s\S]*?\n\$\$;/i,
    )?.[0];

    expect(completion).toBeDefined();
    expect(completion).toMatch(
      /v_probe\.source_type = 'staging'[\s\S]*v_probe\.fence_generation is not null[\s\S]*pg_advisory_xact_lock\([\s\S]*mobile-item-submission:/i,
    );
    expect(completion).toMatch(
      /from private\.mobile_item_submissions submission[\s\S]*for update[\s\S]*from private\.pipeline_storage_cleanup_jobs job[\s\S]*for update/i,
    );
    expect(completion).toMatch(
      /v_job\.delete_authorized_at is null[\s\S]*return false/i,
    );
    expect(completion).toMatch(
      /v_submission\.cleanup_generation[\s\S]*is distinct from v_job\.fence_generation[\s\S]*return false/i,
    );
    expect(completion).toMatch(
      /delete from private\.pipeline_storage_cleanup_jobs[\s\S]*delete from private\.mobile_item_submissions[\s\S]*submission\.cleanup_generation = v_job\.fence_generation/i,
    );
  });

  it("expires fixture intents at the earliest constraint-valid claimable boundary", () => {
    const stagingMigration = readFileSync(stagingMigrationPath, "utf8");
    const fixture = readFileSync(fixturePath, "utf8");
    const helper = fixture.match(
      /export async function expireAndClaimStagingCleanup[\s\S]*?const prepared =/i,
    )?.[0];

    expect(stagingMigration).toMatch(
      /pipeline_staging_cleanup_time_check check \(\s*cleanup_after >= created_at\s*\)/i,
    );
    expect(helper).toBeDefined();
    expect(helper).toMatch(
      /update private\.pipeline_staging_cleanup_intents intent[\s\S]*set cleanup_after = intent\.created_at[\s\S]*intent\.created_at <= statement_timestamp\(\)/i,
    );
    expect(helper).not.toMatch(
      /cleanup_after\s*=\s*statement_timestamp\(\)\s*-/i,
    );
  });

  it("keeps request cardinality assertions local to the main concurrency phase", () => {
    const selector = readFileSync(publicSelectorPath, "utf8");
    const revokedCleanup = selector.indexOf(
      "const revokedCleanupJob = await expireAndClaimStagingCleanup",
    );
    const phaseReset = selector.indexOf(
      "observedRequests.length = 0;",
      revokedCleanup,
    );
    const mainSubmission = selector.indexOf(
      "const submission = createGuestSubmission",
      revokedCleanup,
    );
    const mainPhase = selector.slice(phaseReset, selector.length);

    expect(revokedCleanup).toBeGreaterThan(-1);
    expect(phaseReset).toBeGreaterThan(revokedCleanup);
    expect(mainSubmission).toBeGreaterThan(phaseReset);
    expect(mainPhase).toMatch(
      /find_mobile_item_submission[\s\S]*toHaveLength\(2\)[\s\S]*find_mobile_item_submission[\s\S]*toHaveLength\(3\)/i,
    );
    expect(mainPhase).toMatch(
      /resolve_pipeline_staging_cleanup_intent[\s\S]*toHaveLength\(0\)/i,
    );
  });
});

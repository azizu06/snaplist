import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260713003000_review_identity_regeneration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("review regeneration migration security guards", () => {
  it("rejects NULL and empty Clerk subjects before any tenant-scoped mutation", () => {
    expect(migration).toMatch(
      /if\s+v_user_id\s+is\s+null\s+or\s+v_user_id\s*=\s*''\s+then/i,
    );
  });

  it("requires a strictly positive usable price", () => {
    expect(migration).toMatch(
      /if\s+p_price\s+is\s+null\s+or\s+p_price\s*<=\s*0\s+then/i,
    );
  });

  it("coordinates regeneration with an atomic publish claim and authoritative live fields", () => {
    expect(migration).toMatch(
      /create\s+or\s+replace\s+function\s+public\.begin_ebay_publish/i,
    );
    expect(migration).toMatch(/set\s+ebay_status\s*=\s*'publishing'/i);
    expect(migration).toMatch(/run_id\s+is\s+not\s+distinct\s+from\s+p_expected_run_id/i);
    expect(migration).toMatch(/ebay_listing_id\s+is\s+null/i);
    expect(migration).toMatch(/ebay_status\s+is\s+distinct\s+from\s+'published'/i);
  });

  it("makes publish acquisition advance the shared review revision", () => {
    const publishFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.begin_ebay_publish[\s\S]*?\$\$;/i,
    )?.[0];
    expect(publishFunction).toMatch(/p_expected_review_revision\s+uuid/i);
    expect(publishFunction).toMatch(
      /update\s+public\.items[\s\S]*review_revision\s*=\s*v_claim_id[\s\S]*review_revision\s+is\s+not\s+distinct\s+from\s+p_expected_review_revision/i,
    );
  });

  it("makes abandoned publish claims recoverable with an owned expiring lease", () => {
    expect(migration).toMatch(/ebay_publish_claim_id\s+uuid/i);
    expect(migration).toMatch(/ebay_publish_claimed_at\s+timestamptz/i);
    expect(migration).toMatch(/ebay_publish_claimed_at\s*<\s*now\(\)\s*-\s*interval/i);
    expect(migration).toMatch(/returning\s+ebay_publish_claim_id\s+into/i);
  });

  it("commits regeneration only against the listing version that was loaded", () => {
    const regenerationFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.regenerate_review_listing[\s\S]*?\$\$;/i,
    )?.[0];
    expect(regenerationFunction).toMatch(/p_expected_run_id\s+uuid/i);
    expect(regenerationFunction).toMatch(
      /run_id\s+is\s+not\s+distinct\s+from\s+p_expected_run_id/i,
    );
  });

  it("uses one item-owned review revision for every review mutation", () => {
    expect(migration).toMatch(/alter\s+table\s+public\.items[\s\S]*review_revision\s+uuid/i);
    expect(migration).toMatch(/create\s+or\s+replace\s+function\s+public\.save_review_edits/i);
    expect(migration).toMatch(/create\s+or\s+replace\s+function\s+public\.sharpen_review_estimate/i);
    expect(migration).toMatch(
      /review_revision\s+is\s+not\s+distinct\s+from\s+p_expected_review_revision/i,
    );
  });

  it("blocks every review mutation against non-editable eBay state", () => {
    for (const functionName of [
      "regenerate_review_listing",
      "save_review_edits",
      "sharpen_review_estimate",
    ]) {
      const reviewMutation = migration.match(
        new RegExp(
          `create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}[\\s\\S]*?\\$\\$;`,
          "i",
        ),
      )?.[0];
      expect(reviewMutation).toMatch(
        /status\s+is\s+(?:not\s+)?distinct\s+from\s+'published'/i,
      );
      expect(reviewMutation).toMatch(/ebay_listing_id\s+is\s+(?:not\s+)?null/i);
      expect(reviewMutation).toMatch(
        /ebay_status\s+is\s+(?:not\s+)?distinct\s+from\s+'publishing'/i,
      );
      expect(reviewMutation).toMatch(
        /ebay_status\s+is\s+(?:not\s+)?distinct\s+from\s+'published'/i,
      );
    }
  });

  it("versions export packs and rejects obsolete in-flight persistence", () => {
    expect(migration).toMatch(
      /alter\s+table\s+public\.listings[\s\S]*source_review_revision\s+uuid/i,
    );
    expect(migration).toMatch(
      /create\s+or\s+replace\s+function\s+public\.persist_export_packs/i,
    );
    expect(migration).toMatch(
      /review_revision\s+is\s+not\s+distinct\s+from\s+p_source_review_revision/i,
    );
  });

  it("replaces an invalid current-revision export pack after regeneration", () => {
    const persistFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.persist_export_packs[\s\S]*?\$\$;/i,
    )?.[0];
    expect(persistFunction).toMatch(
      /on\s+conflict\s*\(item_id,\s*platform,\s*source_review_revision\)\s+do\s+update/i,
    );
  });

  it("prunes obsolete export packs whenever save or sharpen advances the review", () => {
    for (const functionName of ["save_review_edits", "sharpen_review_estimate"]) {
      const reviewMutation = migration.match(
        new RegExp(
          `create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}[\\s\\S]*?\\$\\$;`,
          "i",
        ),
      )?.[0];
      expect(reviewMutation).toMatch(
        /delete\s+from\s+public\.listings[\s\S]*platform\s+in\s*\('facebook',\s*'mercari'\)/i,
      );
    }
  });

  it("ordinary saves preserve stored load-bearing identity", () => {
    const saveFunction = migration.match(
      /create\s+or\s+replace\s+function\s+public\.save_review_edits[\s\S]*?\$\$;/i,
    )?.[0];
    expect(saveFunction).not.toMatch(/set\s+attributes\s*=\s*p_attributes/i);
    expect(saveFunction).not.toMatch(/condition\s*=\s*p_condition/i);
    expect(saveFunction).toMatch(/p_attributes\s*->\s*'measurements'/i);
  });
});

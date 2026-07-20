import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260720170000_versioned_photo_set_identity.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("versioned photo-set identity migration", () => {
  it("persists one immutable identity pair on item, run, and reservation truth", () => {
    for (const table of ["items", "pipeline_runs", "ai_item_credit_reservations"]) {
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table}[\\s\\S]+photo_identity_kind`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table}[\\s\\S]+photo_identity_fingerprint`, "i"),
      );
    }
    expect(migration).toMatch(/content_sha256_set_v1/i);
    expect(migration).toMatch(/legacy_path_v0/i);
    expect(migration).toMatch(/enforce_photo_identity_immutable/i);
    expect(migration).toMatch(/stage_pipeline_batch\([\s\S]+p_photo_identities jsonb/i);
    expect(migration).toMatch(
      /assign_item_photo_identity\(\)[\s\S]+session_user[\s\S]+postgres[\s\S]+supabase_admin/i,
    );
  });

  it("allows guided correction only when verified content equivalence is provable", () => {
    expect(migration).toMatch(
      /create or replace function public\.authorize_ai_item_guided_correction\([\s\S]+content_sha256_set_v1/i,
    );
    expect(migration).toMatch(
      /reservation\.photo_identity_kind\s*=\s*item\.photo_identity_kind/i,
    );
    expect(migration).toMatch(
      /reservation\.photo_identity_fingerprint\s*=\s*item\.photo_identity_fingerprint/i,
    );
    expect(migration).toMatch(/legacy photo identity cannot prove same-photo correction/i);
  });
});

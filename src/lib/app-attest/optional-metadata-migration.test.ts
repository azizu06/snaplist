import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = [
  "20260808131433_app_attest_optional_metadata.sql",
  "20260808131803_app_attest_optional_metadata_pair_integrity.sql",
]
  .map((fileName) =>
    readFileSync(
      new URL(`../../../supabase/migrations/${fileName}`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

describe("App Attest optional metadata migration", () => {
  it("allows only a complete metadata pair or an honestly absent pair", () => {
    expect(migration).toMatch(/alter column bundle_version drop not null/i);
    expect(migration).toMatch(/alter column validation_category drop not null/i);
    expect(migration).toMatch(
      /bundle_version is null and validation_category is null/i,
    );
    expect(migration).toMatch(
      /bundle_version is not null[\s\S]+validation_category is not null[\s\S]+nullif\(btrim\(bundle_version\), ''\) is not null[\s\S]+validation_category between 1 and 6/i,
    );
  });
});

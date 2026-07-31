import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  license?: string;
};

const readRepositoryFile = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("Repository license", () => {
  it("publishes the Apache License 2.0 at the repository root", () => {
    const license = readRepositoryFile("../LICENSE");

    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("Copyright 2026 Abduaziz Umarov");
  });

  it("declares the matching SPDX identifier in package.json", () => {
    const manifest = JSON.parse(readRepositoryFile("../package.json")) as PackageManifest;

    expect(manifest.license).toBe("Apache-2.0");
  });
});

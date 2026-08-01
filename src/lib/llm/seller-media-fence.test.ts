import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LLM_ROLES,
  SELLER_MEDIA_ROLES,
  geminiBillingConfigError,
  resolveLanguageModel,
  sellerMediaConfigError,
  type LlmRole,
} from "./registry";
import { parseEnv } from "../env";

/**
 * The seller-media fence (issue #501).
 *
 * Google's Gemini API Terms split on BILLING, not on environment. Under Unpaid
 * Services Google uses submitted content "to improve, and develop Google products
 * and services" and "Human reviewers may read, annotate, and process your API
 * input and output"; under Paid Services it does not, and only then are the
 * retention controls available at all. The Google project this repository is
 * configured against is confirmed free tier with no billing configured (owner,
 * 2026-07-25, recorded in ADR-0002).
 *
 * Seller photos are taken inside people's homes and carry faces, addresses,
 * documents, and surroundings well beyond the item. The `vision` role hands their
 * raw bytes to a model. So a deploy may not route that role to Gemini unless an
 * operator has attested that the project behind the key is billing-enabled.
 *
 * PR #507 fenced the provider being reached by OMISSION (an unset `LLM_PROVIDER`).
 * This file fences it being reached by CHOICE, which is the likelier mistake:
 * Gemini was picked for its free tier in the first place, so "save money, set
 * LLM_PROVIDER=gemini in production" is a reasonable-sounding decision that used
 * to route every seller photo into the unpaid bargain with nothing objecting.
 */

const DEPLOY = { NODE_ENV: "production", LLM_PROVIDER: "gemini" } as const;

describe("sellerMediaConfigError", () => {
  it("refuses a seller-media role on unpaid Gemini outside local development", () => {
    const error = sellerMediaConfigError("vision", "google", DEPLOY);
    expect(error).toMatch(/UNPAID/);
    expect(error).toMatch(/GEMINI_BILLING_ENABLED/);
  });

  it("refuses on a hosted platform's marker even when NODE_ENV claims development", () => {
    // A deploy that sets NODE_ENV=development must not read as a developer's box.
    for (const marker of ["VERCEL", "RENDER", "RAILWAY_ENVIRONMENT", "FLY_APP_NAME"]) {
      expect(
        sellerMediaConfigError("vision", "google", {
          NODE_ENV: "development",
          [marker]: "1",
        }),
      ).toMatch(/GEMINI_BILLING_ENABLED/);
    }
  });

  it("allows it once the operator attests the project is billing-enabled", () => {
    // Paid Services terms then apply, which is the whole point of asking.
    expect(
      sellerMediaConfigError("vision", "google", {
        ...DEPLOY,
        GEMINI_BILLING_ENABLED: "true",
      }),
    ).toBeUndefined();
    // Casing and surrounding whitespace are not a trap for the operator.
    expect(
      sellerMediaConfigError("vision", "google", {
        ...DEPLOY,
        GEMINI_BILLING_ENABLED: "  TRUE ",
      }),
    ).toBeUndefined();
  });

  it("allows local development, where the photos are the developer's own", () => {
    // ADR-0002 records the condition this rests on. Named explicitly rather than
    // reached by fallthrough, so it cannot be satisfied by forgetting something.
    expect(sellerMediaConfigError("vision", "google", { NODE_ENV: "development" })).toBeUndefined();
    expect(sellerMediaConfigError("vision", "google", { NODE_ENV: "test" })).toBeUndefined();
    expect(sellerMediaConfigError("vision", "google", {})).toBeUndefined();
  });

  it("does not fence OpenAI, or roles that carry no seller media", () => {
    // The other direction. Without this, a fence that refused everything — or one
    // whose condition was inverted — would leave the suite green.
    expect(sellerMediaConfigError("vision", "openai", DEPLOY)).toBeUndefined();
    for (const role of LLM_ROLES) {
      if (SELLER_MEDIA_ROLES.has(role)) continue;
      expect(sellerMediaConfigError(role, "google", DEPLOY)).toBeUndefined();
    }
  });

  it("treats an explicit denial as not attested", () => {
    expect(
      sellerMediaConfigError("vision", "google", { ...DEPLOY, GEMINI_BILLING_ENABLED: "false" }),
    ).toMatch(/GEMINI_BILLING_ENABLED/);
  });
});

describe("geminiBillingConfigError", () => {
  it("rejects a value that is neither true nor false, whatever the provider", () => {
    // An attestation that silently read as `false` would look set and act unset.
    // A `yes` sitting harmlessly on an OpenAI deploy must not become a surprise
    // the day someone flips LLM_PROVIDER, so the vocabulary is checked either way.
    expect(geminiBillingConfigError({ GEMINI_BILLING_ENABLED: "yes" })).toMatch(/"yes"/);
    expect(sellerMediaConfigError("listing", "openai", { GEMINI_BILLING_ENABLED: "1" })).toMatch(
      /GEMINI_BILLING_ENABLED/,
    );
  });

  it("accepts unset, true, and false", () => {
    expect(geminiBillingConfigError({})).toBeUndefined();
    expect(geminiBillingConfigError({ GEMINI_BILLING_ENABLED: "" })).toBeUndefined();
    expect(geminiBillingConfigError({ GEMINI_BILLING_ENABLED: "true" })).toBeUndefined();
    expect(geminiBillingConfigError({ GEMINI_BILLING_ENABLED: "false" })).toBeUndefined();
  });
});

describe("resolveLanguageModel", () => {
  it("refuses to construct a vision model on a deploy that chose Gemini without attesting billing", async () => {
    await expect(
      resolveLanguageModel("vision", {
        provider: "google",
        apiKey: "test-key",
        env: DEPLOY,
      }),
    ).rejects.toThrow(/GEMINI_BILLING_ENABLED/);
  });

  it("fences a call site that FORCES the provider, not just one that reads LLM_PROVIDER", async () => {
    // The eval's cross-family judge and the spike scripts pass `provider`
    // explicitly. The fence keys on the EFFECTIVE provider so those cannot walk
    // around a deploy that chose OpenAI.
    await expect(
      resolveLanguageModel("vision", {
        provider: "google",
        apiKey: "test-key",
        env: { NODE_ENV: "production", LLM_PROVIDER: "openai" },
      }),
    ).rejects.toThrow(/GEMINI_BILLING_ENABLED/);
  });

  it("still constructs the model once billing is attested", async () => {
    const model = await resolveLanguageModel("vision", {
      provider: "google",
      apiKey: "test-key",
      env: { ...DEPLOY, GEMINI_BILLING_ENABLED: "true" },
    });
    expect(model).toBeTruthy();
  });
});

describe("parseEnv", () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    GEMINI_API_KEY: "g",
  };

  it("fails config startup for a deploy that chose Gemini without attesting billing", () => {
    // Earlier and friendlier than failing on the first seller's photo: a deploy
    // configured this way cannot process a single item, so say so at boot.
    expect(() =>
      parseEnv({ ...base, NODE_ENV: "production", LLM_PROVIDER: "gemini", VERCEL: "1" }),
    ).toThrowError(/GEMINI_BILLING_ENABLED/);
  });

  it("accepts the same deploy once billing is attested", () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        LLM_PROVIDER: "gemini",
        VERCEL: "1",
        GEMINI_BILLING_ENABLED: "true",
      }),
    ).not.toThrow();
  });

  it("accepts a Gemini-only local development box unchanged", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "development" })).not.toThrow();
  });
});

/**
 * The drift guard — the part of this file meant to outlive the change that added
 * it. The fence above keys on a ROLE, so it silently stops applying the moment a
 * role that is not in `SELLER_MEDIA_ROLES` starts sending media. Nothing about
 * that failure is visible: the code compiles, the tests pass, and seller photos
 * quietly resume flowing to whatever provider is configured.
 *
 * So this reads the source instead of trusting the set: every module that builds
 * a media message part must be one of the known seller-media modules, and each of
 * those must resolve its model for a role the fence covers. A new media call site
 * fails here until someone decides, deliberately, what the fence should do about
 * it.
 */
const MEDIA_PART = /type:\s*"(image|file|audio)"/;
const RESOLVE_ROLE = /resolveLanguageModel\(\s*"([A-Za-z]+)"/g;

/** Modules that legitimately send seller media, and the role each sends it under. */
const SELLER_MEDIA_MODULES: Record<string, LlmRole> = {
  "src/lib/vision/extract.ts": "vision",
  "src/lib/vision/measurements.ts": "vision",
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "fixtures") sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Source lines with comments dropped, so prose about media parts is not a hit. */
function codeLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    });
}

describe("seller-media drift guard", () => {
  const srcRoot = path.resolve(__dirname, "../..");
  const repoRoot = path.resolve(srcRoot, "..");

  it("finds media message parts only in the known seller-media modules", () => {
    const found = sourceFiles(srcRoot)
      .filter((file) => codeLines(file).some((line) => MEDIA_PART.test(line)))
      .map((file) => path.relative(repoRoot, file))
      .sort();

    expect(found).toEqual(Object.keys(SELLER_MEDIA_MODULES).sort());
  });

  it("routes every seller-media module through a role the fence covers", () => {
    for (const [relative, expectedRole] of Object.entries(SELLER_MEDIA_MODULES)) {
      const source = readFileSync(path.join(repoRoot, relative), "utf8");
      const roles = [...source.matchAll(RESOLVE_ROLE)].map((match) => match[1]);

      expect(roles, `${relative} must resolve a model through the registry`).not.toHaveLength(0);
      for (const role of roles) {
        expect(role, `${relative} resolves role "${role}"`).toBe(expectedRole);
        expect(SELLER_MEDIA_ROLES.has(role as LlmRole)).toBe(true);
      }
    }
  });

  it("keeps every seller-media role a real registry role", () => {
    for (const role of SELLER_MEDIA_ROLES) {
      expect(LLM_ROLES).toContain(role);
    }
  });
});
